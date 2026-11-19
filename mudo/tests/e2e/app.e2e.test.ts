/**
 * E2E no app Electron real (build em out/). Requer `npm run build` antes e,
 * no Linux sem tela, rodar sob xvfb (`npm run test:e2e`).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { helperSecrets } from '../../src/cli/helper-secrets'
import { createChannel, dataPaths, openDatabase, resolveMediaBinaries } from '../../src/core'
import { tempRoot } from '../helpers/env'
import { seedCut, seedVideo } from './seed'

const APP_DIR = path.resolve(__dirname, '../..')
const ELECTRON = require('electron') as unknown as string

const roots: string[] = []
let apps: ElectronApplication[] = []

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined)
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_OPTIONS' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  return { ...env, ...extra }
}

async function launch(dataDir: string, extraArgs: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const args = [APP_DIR, ...extraArgs]
  if (process.platform === 'linux') args.push('--no-sandbox') // contêiner como root
  const app = await electron.launch({ executablePath: ELECTRON, args, env: cleanEnv({ MUDO_DATA_DIR: dataDir, MUDO_ORPHAN_MS: '2000', ...(process.env.MUDO_ALLOW_BASIC_SECRET_STORE ? { MUDO_ALLOW_BASIC_SECRET_STORE: '1' } : {}) }) })
  apps.push(app)
  const page = await app.firstWindow()
  await page.locator('[data-testid="runner-status"][data-state="running"]').waitFor({ timeout: 30_000 })
  return { app, page }
}

describe('app Electron', () => {
  it('Primeiro uso → Meus Vídeos: Gerar enfileira, custo estimado aparece e sem chave o vídeo pede ação; cancelar pela UI', async () => {
    const root = tempRoot('mudo e2e ação ')
    roots.push(root)
    // primeiro uso: assistente curto (chaves + primeiro canal) e depois Meus Vídeos
    const { page } = await launch(root)
    await page.getByTestId('onboarding').waitFor()
    await page.getByTestId('onboarding-next').click()
    await page.getByTestId('ch-name').fill('Canal Ciência')
    await page.getByTestId('ch-niche').fill('ciência do dia a dia')
    await page.getByTestId('onboarding-finish').click()
    await page.getByTestId('theme').waitFor()
    await page.getByTestId('theme').fill('Por que o céu é azul')
    await expect.poll(async () => page.getByTestId('estimate').textContent(), { timeout: 10_000 }).toContain('Sem provedor configurado')
    await page.getByTestId('generate').click()
    const row = page.locator('[data-testid="video-row"][data-state="needs_input"]')
    await row.waitFor({ timeout: 30_000 })
    await expect(row.textContent()).resolves.toContain('Adicione uma chave de API')
    await row.getByRole('button', { name: 'Cancelar' }).click()
    await page.locator('[data-testid="video-row"][data-state="cancelled"]').waitFor()
  })

  it('Biblioteca: thumbnail e player pelo protocolo mudo-media, aviso de IA, copiar título e apagar', async () => {
    const root = tempRoot('mudo e2e biblioteca ')
    roots.push(root)
    const { videoId, outputPath } = await seedVideo(root, 'done')
    const { app, page } = await launch(root)
    await page.getByTestId('nav-library').click()
    const card = page.locator(`[data-testid="library-card"][data-video-id="${videoId}"]`)
    await card.waitFor()
    await expect.poll(() => card.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 10_000 }).toBe(1280)
    await card.click()
    const player = page.getByTestId('player')
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 15_000 }).toBeGreaterThan(50)
    await expect(page.getByTestId('library-ai-notice').textContent()).resolves.toContain('conteúdo alterado ou sintético')
    await page.getByTestId('copy-title').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Por que o céu é azul? A resposta em um minuto')
    await page.getByTestId('delete-video').click()
    await page.getByTestId('confirm-delete').click()
    await card.waitFor({ state: 'detached' })
    expect(fs.existsSync(outputPath)).toBe(false)
  })

  it('editar roteiro em "aguardando você": issues ao lado, salvar retoma a geração com o texto novo', async () => {
    const root = tempRoot('mudo e2e roteiro ')
    roots.push(root)
    const { videoId } = await seedVideo(root, 'review-rejected')
    const { page } = await launch(root)
    const row = page.locator(`[data-testid="video-row"][data-video-id="${videoId}"][data-state="needs_input"]`)
    await row.waitFor()
    await row.getByTestId('edit-script').click()
    const editor = page.getByTestId('act-editor').first()
    await editor.waitFor()
    await expect(page.getByRole('dialog').textContent()).resolves.toContain('Afirmação duvidosa')
    await editor.getByRole('textbox', { name: 'Narração do ato 1' }).fill('Você já reparou que o céu muda de cor ao longo do dia? Hoje vamos entender por quê.')
    await page.getByTestId('save-script').click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    // retomou: passa da revisão (decisão humana) e, sem chave no app, para nas imagens pedindo ação
    await page.locator(`[data-testid="video-row"][data-video-id="${videoId}"][data-stage="images"][data-state="needs_input"]`).waitFor({ timeout: 30_000 })
    const h = openDatabase(dataPaths(root).db)
    expect(h.sqlite.prepare('SELECT text FROM acts WHERE video_id = ? AND n = 1').get(videoId)).toEqual({ text: 'Você já reparou que o céu muda de cor ao longo do dia? Hoje vamos entender por quê.' })
    h.close()
  })

  it('renderer isolado: sem Node, só a ponte tipada; entrada inválida e canal desconhecido recusados', async () => {
    const root = tempRoot('mudo e2e ponte ')
    roots.push(root)
    const { page } = await launch(root)
    const r = await page.evaluate(async () => {
      const w = window as unknown as { require?: unknown; process?: unknown; mudo: { invoke: (c: string, a?: unknown) => Promise<unknown> } }
      let invalid = ''
      try {
        await w.mudo.invoke('jobs:cancel', { id: 'não-é-uuid' })
      } catch {
        invalid = 'recusado'
      }
      let unknownChannel = ''
      try {
        await w.mudo.invoke('fs:read', {})
      } catch {
        unknownChannel = 'recusado'
      }
      return { require: typeof w.require, process: typeof w.process, invalid, unknownChannel }
    })
    expect(r).toEqual({ require: 'undefined', process: 'undefined', invalid: 'recusado', unknownChannel: 'recusado' })
  })

  it('chaves: CLI guarda via modo auxiliar do app (safeStorage); config.json não tem texto claro', async () => {
    const root = tempRoot('mudo e2e chaves ')
    roots.push(root)
    process.env.MUDO_DATA_DIR = root
    if (process.platform === 'linux') process.env.MUDO_ALLOW_BASIC_SECRET_STORE = '1'
    try {
      // Linux de CI não tem chaveiro: usa o backend "basic" do Chromium. No Windows é DPAPI.
      const linux = process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : []
      const s = helperSecrets({ exec: ELECTRON, args: [APP_DIR, ...linux] })
      const secret = 'sk-ant-TESTE-NAO-REAL-1234567890'
      expect(await s.set('anthropic', secret)).toEqual(['anthropic'])
      expect(await s.list()).toEqual(['anthropic'])
      expect(await s.get('anthropic')).toBe(secret)
      const cfg = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
      expect(cfg).not.toContain(secret)
      expect(cfg).not.toContain('TESTE-NAO-REAL')
      // nem no banco nem nos logs
      for (const f of fs.readdirSync(path.join(root, 'logs'), { recursive: true }) as string[]) {
        const p = path.join(root, 'logs', f)
        if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain('TESTE-NAO-REAL')
      }
      expect(await s.remove('anthropic')).toEqual([])
    } finally {
      delete process.env.MUDO_DATA_DIR
      delete process.env.MUDO_ALLOW_BASIC_SECRET_STORE
    }
  })

  it('CLI compilada roda no executável do Electron em modo Node (sem Node instalado)', () => {
    const root = tempRoot('mudo e2e cli ')
    roots.push(root)
    const run = (...args: string[]) =>
      spawnSync(ELECTRON, [path.join(APP_DIR, 'out', 'main', 'cli.js'), ...args], {
        env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1', MUDO_DATA_DIR: root }),
        encoding: 'utf8',
      })
    const c = run('channel', 'create', '--name', 'Canal Ação', '--niche', 'história', '--lang', 'es', '--json')
    // no Linux o sharp avisa que o Electron pode ser incompatível (não ocorre no Windows); nada além disso
    const stderr = c.stderr.split('\n').filter((l) => l && !l.includes('SharpElectronLinux') && !l.includes('--trace-warnings'))
    expect(stderr).toEqual([])
    expect(c.status).toBe(0)
    const { channelId } = JSON.parse(c.stdout)
    const l = run('channel', 'list', '--json')
    expect(JSON.parse(l.stdout)[0]).toMatchObject({ channelId, name: 'Canal Ação', language: 'es' })
    expect(run('generate', '--theme', 'x', '--channel', channelId).status).toBe(2)

    // sharp + CLIP (onnxruntime) carregam no runtime do Electron
    const img = path.join(root, 'foto.png')
    spawnSync(process.execPath, ['-e', `require('sharp')({create:{width:1920,height:1080,channels:3,background:'#3366cc'}}).png().toFile(${JSON.stringify(img)})`], { cwd: APP_DIR })
    const imp = run('images', 'import', img, '--license', 'own', '--json')
    expect(imp.status).toBe(0)
    expect(JSON.parse(imp.stdout)).toMatchObject({ imported: 1 })
    const db = openDatabase(path.join(root, 'mudo.db'))
    expect(db.sqlite.prepare('SELECT embedding_model FROM images').get()).toEqual({ embedding_model: 'clip:Xenova/clip-vit-base-patch32:q8' })
    db.close()
  })

  it('MCP em stdio pela CLI compilada: lista ferramentas, cria canal e responde job_status', async () => {
    const root = tempRoot('mudo e2e mcp ')
    roots.push(root)
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const transport = new StdioClientTransport({
      command: ELECTRON,
      args: [path.join(APP_DIR, 'out', 'main', 'cli.js'), 'mcp'],
      env: cleanEnv({ ELECTRON_RUN_AS_NODE: '1', MUDO_DATA_DIR: root }),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'e2e', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['channel_create', 'cost_estimate', 'generate_video', 'job_status', 'library_list'])
      const ch = (await client.callTool({ name: 'channel_create', arguments: { name: 'Canal MCP', niche: 'história', language: 'en' } })) as unknown as {
        structuredContent: { channelId: string }
      }
      expect(ch.structuredContent.channelId).toMatch(/^[0-9a-f-]{36}$/)
      const st = (await client.callTool({ name: 'job_status', arguments: { job_id: 'nao-existe' } })) as { isError: boolean }
      expect(st.isError).toBe(true)
    } finally {
      await client.close()
    }
    // o canal foi gravado no banco de dados do app
    const db = openDatabase(path.join(root, 'mudo.db'))
    expect(db.sqlite.prepare('SELECT name FROM channels').get()).toEqual({ name: 'Canal MCP' })
    db.close()
  })

  it('Canais, Configurações (chave cifrada + testar conexão) e Licenças com exportação CSV', async () => {
    const root = tempRoot('mudo e2e telas ')
    roots.push(root)
    const { videoId } = await seedVideo(root, 'done')
    process.env.MUDO_ALLOW_BASIC_SECRET_STORE = '1'
    const { app, page } = await launch(root, process.platform === 'linux' ? ['--password-store=basic'] : [])
    delete process.env.MUDO_ALLOW_BASIC_SECRET_STORE

    // Canais: criar e ver na lista
    await page.getByTestId('nav-channels').click()
    await page.getByTestId('new-channel').click()
    await page.getByTestId('ch-name').fill('História Rápida')
    await page.getByTestId('ch-niche').fill('história')
    await page.getByTestId('save-channel').click()
    await expect.poll(() => page.getByTestId('channel-card').count()).toBe(2)

    // Configurações: guardar chave (some do campo), testar conexão sem rede para o provedor
    await page.getByTestId('nav-settings').click()
    const row = page.getByTestId('key-pexels')
    await row.getByRole('textbox').fill('chave-de-teste-pexels-123')
    await row.getByRole('button', { name: 'Salvar' }).click()
    await expect.poll(() => row.getByRole('textbox').inputValue()).toBe('')
    await row.getByRole('button', { name: 'Testar conexão' }).click()
    await expect.poll(() => row.textContent(), { timeout: 30_000 }).toMatch(/recusada|conectar|HTTP|Sem resposta/)
    const cfg = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
    expect(cfg).not.toContain('chave-de-teste-pexels-123')
    expect(await page.content()).not.toContain('chave-de-teste-pexels-123')

    // Licenças: tabela do vídeo e CSV (diálogo nativo substituído só neste teste)
    await page.getByTestId('nav-licenses').click()
    await page.getByTestId('licenses-table').waitFor()
    await expect(page.getByTestId('licenses-table').textContent()).resolves.toContain('Pexels')
    const csvPath = path.join(root, 'licencas.csv')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
    }, csvPath)
    await page.getByRole('button', { name: 'Exportar CSV' }).click()
    await expect.poll(() => fs.existsSync(csvPath)).toBe(true)
    expect(fs.readFileSync(csvPath, 'utf8')).toContain(videoId)

    // Biblioteca mostra o medidor de cota
    await page.getByTestId('nav-library').click()
    await expect(page.getByTestId('quota-meter').textContent()).resolves.toContain('Ilimitado')
  })

  it('Cortes (Beta): exige autorização; o app transcreve (whisper) e, sem chave, pede ação; exporta 9:16 de trechos prontos', async () => {
    const root = tempRoot('mudo e2e cortes ')
    roots.push(root)
    const sample = path.join(root, 'minha palestra.mp4')
    const jfk = path.resolve(__dirname, '../fixtures/audio/jfk.wav')
    spawnSync(resolveMediaBinaries().ffmpeg, [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=36', '-i', jfk, '-i', jfk, '-i', jfk,
      '-filter_complex', '[1:a]apad=pad_dur=1[a1];[2:a]apad=pad_dur=1[a2];[3:a][a1][a2]concat=n=3:v=0:a=1[a]',
      '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample,
    ])
    const { highlightId } = await seedCut(root, sample)

    const { page } = await launch(root)
    await page.getByTestId('nav-cuts').click()
    // sem marcar a autorização, não analisa
    await page.getByTestId('cut-source').fill(sample)
    await expect(page.getByTestId('cut-create').isDisabled()).resolves.toBe(true)
    await page.getByTestId('cut-authorized').check()
    await page.getByTestId('cut-create').click()
    const pending = page.locator('[data-testid="cut-item"][data-state="needs_input"]')
    await pending.waitFor({ timeout: 120_000 })
    await expect(page.getByTestId('cut-detail').textContent()).resolves.toContain('Adicione uma chave de API')
    await expect(page.getByTestId('transcript').textContent()).resolves.toMatch(/country/i)

    // trechos já analisados (fixture): exportar 9:16 roda no runner do app
    await page.locator('[data-testid="cut-item"][data-state="done"]').click()
    await page.getByTestId('highlight').first().getByTestId('export-cut').click()
    await page.getByRole('button', { name: 'Ver arquivo 9:16' }).waitFor({ timeout: 120_000 })
    const h = openDatabase(dataPaths(root).db)
    const row = h.sqlite.prepare('SELECT exported_path FROM cut_highlights WHERE id = ?').get(highlightId) as { exported_path: string }
    h.close()
    expect(fs.existsSync(row.exported_path)).toBe(true)
  })
})
