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
import { createChannel, dataPaths, openDatabase } from '../../src/core'
import { tempRoot } from '../helpers/env'
import { seedVideo } from './seed'

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

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const args = [APP_DIR]
  if (process.platform === 'linux') args.push('--no-sandbox') // contêiner como root
  const app = await electron.launch({ executablePath: ELECTRON, args, env: cleanEnv({ MUDO_DATA_DIR: dataDir, MUDO_ORPHAN_MS: '2000' }) })
  apps.push(app)
  const page = await app.firstWindow()
  await page.locator('[data-testid="runner-status"][data-state="running"]').waitFor({ timeout: 30_000 })
  return { app, page }
}

describe('app Electron', () => {
  it('Meus Vídeos: sem canal mostra o que fazer; com canal, Gerar enfileira, custo estimado aparece e sem chave o vídeo pede ação; cancelar pela UI', async () => {
    const root = tempRoot('mudo e2e ação ')
    roots.push(root)
    const first = await launch(root)
    await first.page.getByTestId('no-channels').waitFor()
    await first.app.close()
    apps = apps.filter((a) => a !== first.app)

    const h = openDatabase(dataPaths(root).db)
    createChannel(h, { name: 'Canal Ciência', niche: 'ciência', language: 'pt-BR' })
    h.close()
    const { page } = await launch(root)
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
})
