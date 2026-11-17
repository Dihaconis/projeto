/**
 * Smoke do APP EMPACOTADO (release/*-unpacked): o que o instalador entrega.
 * Roda com `npm run test:packaged` (gera o pacote antes). No Windows o
 * workflow de CI faz o mesmo sobre o NSIS instalado.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import { tempRoot } from '../helpers/env'

const ROOT = path.resolve(__dirname, '../..')
const win = process.platform === 'win32'
const UNPACKED = path.join(ROOT, 'release', win ? 'win-unpacked' : 'linux-unpacked')
const EXE = path.join(UNPACKED, win ? 'MUDO.exe' : 'mudo')
const CLI = path.join(UNPACKED, 'resources', 'cli', win ? 'mudo.cmd' : 'mudo')
const roots: string[] = []
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))

/** Roda a CLI empacotada; no Windows via cmd.exe com aspas corretas (mudo.cmd). */
function runCli(args: string[], env: Record<string, string>) {
  if (!win) return spawnSync(CLI, args, { env, encoding: 'utf8' })
  const q = (a: string) => `"${a.replace(/"/g, '""')}"`
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${q(CLI)} ${args.map(q).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true })
}

/** Ambiente sem Node no PATH: prova que o pacote não depende de Node instalado. */
function envWithoutNode(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'npm_node_execpath', 'NODE'].includes(k)) env[k] = v
  const sep = win ? ';' : ':'
  env.PATH = (env.PATH ?? '').split(sep).filter((p) => !fs.existsSync(path.join(p, win ? 'node.exe' : 'node'))).join(sep)
  return { ...env, ...extra }
}

describe('pacote', () => {
  it('estrutura: asar, nativos fora do asar só da plataforma, binários, modelos, migrações, fontes, CLI', () => {
    const res = path.join(UNPACKED, 'resources')
    for (const p of ['app.asar', 'migrations/meta/_journal.json', `bin/ffmpeg${win ? '.exe' : ''}`, `bin/whisper-cli${win ? '.exe' : ''}`, `bin/yt-dlp${win ? '.exe' : ''}`, 'models/Xenova/clip-vit-base-patch32/onnx/vision_model_quantized.onnx', 'models/ggerganov/whisper.cpp/ggml-base.bin', 'assets/fonts/Anton-Regular.ttf', 'assets/legal/third-party.md']) {
      expect(fs.existsSync(path.join(res, p)), p).toBe(true)
    }
    const pre = fs.readdirSync(path.join(res, 'app.asar.unpacked/node_modules/better-sqlite3/prebuilds'))
    expect(pre).toEqual([`${process.platform}-x64.node`])
    expect(fs.existsSync(path.join(res, 'app.asar.unpacked/node_modules/onnxruntime-web'))).toBe(false)
  })

  it('CLI empacotada roda sem Node no PATH, em pasta com espaço e acento; CLIP e sharp carregam do pacote', async () => {
    const data = tempRoot('mudo pacote ação ')
    roots.push(data)
    const run = (...args: string[]) => runCli(args, envWithoutNode({ MUDO_DATA_DIR: data }))
    const c = run('channel', 'create', '--name', 'Canal Pacote', '--niche', 'teste', '--lang', 'pt-BR', '--json')
    expect(c.status, c.stderr).toBe(0)
    expect(JSON.parse(c.stdout).channelId).toBeTruthy()
    const img = path.join(data, 'foto ção.png')
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#2266aa' } }).png().toFile(img)
    const imp = run('images', 'import', img, '--license', 'own', '--json')
    expect(imp.status, imp.stderr).toBe(0)
    expect(JSON.parse(imp.stdout).imported).toBe(1)
    expect(run('voar').status).toBe(2)
  }, 120_000)

  it('app empacotado abre, migra o banco, sobe o runner e processa um vídeo até pedir a chave', async () => {
    // o fuse que bloqueia --inspect impede o Playwright de se acoplar ao app empacotado
    // (é o comportamento desejado no produto); por isso o teste observa o banco e os logs
    const data = tempRoot('mudo pacote app ')
    roots.push(data)
    const env = envWithoutNode({ MUDO_DATA_DIR: data, MUDO_ORPHAN_MS: '2000' })
    const cli = (...args: string[]) => runCli(args, env)
    const ch = cli('channel', 'create', '--name', 'Canal', '--niche', 'n', '--lang', 'pt-BR', '--json')
    expect(ch.status, ch.stderr).toBe(0)
    const app = spawn(EXE, win ? [] : ['--no-sandbox'], { env, stdio: 'ignore' })
    try {
      const gen = cli('generate', '--theme', 'Teste do pacote', '--channel', JSON.parse(ch.stdout).channelId, '--duration', '420', '--json')
      expect(gen.status, gen.stderr).toBe(0)
      const { jobId } = JSON.parse(gen.stdout)
      const deadline = Date.now() + 90_000
      let status: { state: string; error: { code: string } | null } | null = null
      while (Date.now() < deadline) {
        const st = cli('status', jobId, '--json')
        status = JSON.parse(st.stdout)
        if (status?.state === 'needs_input') break
        await new Promise((r) => setTimeout(r, 1000))
      }
      expect(status).toMatchObject({ state: 'needs_input', error: { code: 'MISSING_KEY' } })
      const logs = fs.readdirSync(path.join(data, 'logs')).join(' ')
      expect(logs).toMatch(/main/)
      expect(logs).toMatch(/runner/)
    } finally {
      const exited = new Promise((r) => app.once('exit', r))
      app.kill()
      await exited
    }
  }, 180_000)
})
