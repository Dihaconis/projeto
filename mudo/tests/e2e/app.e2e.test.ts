/**
 * E2E no app Electron real (build em out/). Requer `npm run build` antes e,
 * no Linux sem tela, rodar sob xvfb (`npm run test:e2e`).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { JobQueue, SELFTEST_STEPS, dataPaths, openDatabase } from '../../src/core'
import { tempRoot, waitFor } from '../helpers/env'

const APP_DIR = path.resolve(__dirname, '../..')
const ELECTRON = require('electron') as unknown as string

let roots: string[] = []
let apps: ElectronApplication[] = []

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined)
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_OPTIONS') env[k] = v
  const args = [APP_DIR]
  if (process.platform === 'linux') args.push('--no-sandbox') // contêiner como root
  const app = await electron.launch({
    executablePath: ELECTRON,
    args,
    env: { ...env, MUDO_DATA_DIR: dataDir, MUDO_ORPHAN_MS: '2000' },
  })
  apps.push(app)
  const page = await app.firstWindow()
  await page.locator('[data-testid="runner-status"][data-state="running"]').waitFor({ timeout: 30_000 })
  return { app, page }
}

/** "Finalizar árvore de processos": mata o main e todos os descendentes. */
function killTree(rootPid: number): void {
  const all = new Set<number>([rootPid])
  const walk = (pid: number) => {
    let out = ''
    try {
      out = execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' })
    } catch {
      return
    }
    for (const s of out.split('\n').map((x) => Number(x.trim())).filter(Boolean)) {
      all.add(s)
      walk(s)
    }
  }
  walk(rootPid)
  for (const pid of all) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // já morreu
    }
  }
}

describe('app Electron', () => {
  it('job de teste sobrevive a matar o app durante a montagem e retoma do checkpoint', async () => {
    const root = tempRoot('mudo e2e ação ')
    roots.push(root)
    const first = await launch(root)
    await first.page.getByRole('radio', { name: 'Normal' }).click()
    await first.page.getByTestId('enqueue-selftest').click()
    const row = first.page.getByTestId('job-row').first()
    await row.waitFor()
    const jobId = (await row.getAttribute('data-job-id'))!

    const h = openDatabase(dataPaths(root).db)
    const q = new JobQueue(h)
    await waitFor(() => {
      const cp = q.get(jobId)?.checkpoint as { steps?: Record<string, true> }
      return cp?.steps?.['assemble:1'] && q.listProcs(jobId).length > 0
    }, 60_000)
    expect(await first.page.locator(`[data-job-id="${jobId}"]`).getAttribute('data-state')).toBe('running')

    const cpAtKill = q.get(jobId)!.checkpoint as { steps: Record<string, true> }
    killTree(first.app.process().pid!)
    apps = apps.filter((a) => a !== first.app)
    expect(q.get(jobId)?.state).toBe('running') // ninguém teve chance de limpar

    const second = await launch(root)
    await second.page.locator(`[data-job-id="${jobId}"][data-state="done"]`).waitFor({ timeout: 60_000 })
    const job = q.get(jobId)!
    expect(job.state).toBe('done')
    expect(job.attempt).toBe(2)

    const lines = fs.readFileSync(path.join(root, 'work', jobId, 'exec.log'), 'utf8').trim().split('\n')
    for (const k of Object.keys(cpAtKill.steps)) expect(lines.filter((l) => l === k)).toHaveLength(1)
    expect(new Set(lines).size).toBe(Object.values(SELFTEST_STEPS).reduce((a, b) => a + b, 0))
    h.close()
  })

  it('fechar o app normalmente devolve o job à fila sem gastar tentativa', async () => {
    const root = tempRoot('mudo e2e fechar ')
    roots.push(root)
    const { app, page } = await launch(root)
    await page.getByRole('radio', { name: 'Lento' }).click()
    await page.getByTestId('enqueue-selftest').click()
    await page.locator('[data-testid="job-row"][data-state="running"]').waitFor()
    await app.close()
    apps = apps.filter((a) => a !== app)

    const h = openDatabase(dataPaths(root).db)
    const [job] = new JobQueue(h).list()
    expect(job).toMatchObject({ state: 'queued', attempt: 0, lockedBy: null })
    h.close()
  })

  it('renderer isolado: sem Node, só a ponte tipada; entrada inválida é recusada', async () => {
    const root = tempRoot('mudo e2e ponte ')
    roots.push(root)
    const { page } = await launch(root)
    const r = await page.evaluate(async () => {
      const w = window as unknown as { require?: unknown; process?: unknown; mudo: { invoke: (c: string, a?: unknown) => Promise<unknown> } }
      let invalid = ''
      try {
        await w.mudo.invoke('jobs:cancel', { id: 'não-é-uuid' })
      } catch (e) {
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
})
