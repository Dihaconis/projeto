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
import { createChannel, createVideoJob, dataPaths, migrateDatabase, openDatabase } from '../../src/core'
import { MIGRATIONS_DIR, tempRoot } from '../helpers/env'

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
  it('runner do app pega o vídeo; sem chave → "aguardando você" com mensagem acionável; cancelar pela UI', async () => {
    const root = tempRoot('mudo e2e ação ')
    roots.push(root)
    const h = openDatabase(dataPaths(root).db)
    migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: dataPaths(root).backups })
    const ch = createChannel(h, { name: 'Canal', niche: 'ciência', language: 'pt-BR' })
    const { job } = createVideoJob(h, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    h.close()

    const { page } = await launch(root)
    const row = page.locator(`[data-job-id="${job.id}"][data-state="needs_input"]`)
    await row.waitFor({ timeout: 30_000 })
    await expect(row.textContent()).resolves.toContain('Adicione uma chave de API')
    await row.getByRole('button', { name: 'Cancelar' }).click()
    await page.locator(`[data-job-id="${job.id}"][data-state="cancelled"]`).waitFor()
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
    expect(c.stderr).toBe('')
    expect(c.status).toBe(0)
    const { channelId } = JSON.parse(c.stdout)
    const l = run('channel', 'list', '--json')
    expect(JSON.parse(l.stdout)[0]).toMatchObject({ channelId, name: 'Canal Ação', language: 'es' })
    expect(run('generate', '--theme', 'x', '--channel', channelId).status).toBe(2)
  })
})
