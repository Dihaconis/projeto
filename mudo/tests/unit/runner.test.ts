import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JobError,
  NeedsInputError,
  Runner,
  SELFTEST_STEPS,
  jobHandlers,
  nullLogger,
  type JobHandlers,
  type RunnerOptions,
} from '../../src/core'
import { STAGES } from '../../src/shared/enums'
import { isAlive, makeEnv, waitFor, type TestEnv } from '../helpers/env'

let env: TestEnv
const runners: Runner[] = []

beforeEach(() => {
  env = makeEnv()
})
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop()
  env.cleanup()
})

function makeRunner(opts: Partial<RunnerOptions> = {}): Runner {
  const r = new Runner({
    handle: env.handle,
    paths: env.paths,
    log: nullLogger(),
    handlers: jobHandlers,
    pollMs: 20,
    heartbeatMs: 50,
    reaperIntervalMs: 100,
    ...opts,
  })
  runners.push(r)
  return r
}

const execLines = (key: string) =>
  fs.readFileSync(path.join(env.paths.work, key, 'exec.log'), 'utf8').trim().split('\n')

describe('Runner + job de teste (Fase 1)', () => {
  it('percorre todas as etapas, grava artefatos, checkpoint e tempos por etapa', async () => {
    const r = makeRunner()
    const job = r.queue.enqueue({ kind: 'selftest', payload: { stepMs: 20 } })
    r.start()
    const done = await waitFor(() => {
      const j = r.queue.get(job.id)
      return j?.state === 'done' ? j : null
    })
    expect(done.progress).toBe(1)
    expect(done.stage).toBe('assemble')
    const timings = done.stageTimings as Record<string, number>
    for (const s of STAGES) {
      expect(timings[s]).toBeGreaterThan(0)
      for (let n = 1; n <= SELFTEST_STEPS[s]; n++) {
        expect(fs.existsSync(path.join(env.paths.work, job.id, s, `${n}.json`))).toBe(true)
      }
    }
    const total = Object.values(SELFTEST_STEPS).reduce((a, b) => a + b, 0)
    expect(execLines(job.id)).toHaveLength(total)
    expect(r.queue.listProcs(job.id)).toHaveLength(0)
  })

  it('pool de 2 jobs, montagem limitada a 1 por vez', async () => {
    let running = 0
    let maxRunning = 0
    let assembling = 0
    let maxAssembling = 0
    const handlers: JobHandlers = {
      selftest: async (ctx) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        ctx.enterStage('script')
        await new Promise((res) => setTimeout(res, 60))
        ctx.enterStage('assemble')
        const release = await ctx.acquire('assemble')
        assembling++
        maxAssembling = Math.max(maxAssembling, assembling)
        await new Promise((res) => setTimeout(res, 60))
        assembling--
        release()
        running--
      },
    }
    const r = makeRunner({ handlers, concurrency: 2 })
    const ids = Array.from({ length: 5 }, () => r.queue.enqueue({ kind: 'selftest', payload: {} }).id)
    r.start()
    await waitFor(() => ids.every((id) => r.queue.get(id)?.state === 'done'))
    expect(maxRunning).toBe(2)
    expect(maxAssembling).toBe(1)
  })

  it('cancelar durante a montagem mata o processo filho e limpa temporários', async () => {
    const r = makeRunner()
    const job = r.queue.enqueue({ kind: 'selftest', payload: { stepMs: 3000 } })
    // pula direto para a montagem marcando as etapas anteriores como feitas
    const steps: Record<string, true> = {}
    for (const s of ['script', 'review', 'images', 'tts'] as const) {
      for (let n = 1; n <= SELFTEST_STEPS[s]; n++) {
        steps[`${s}:${n}`] = true
        const f = path.join(env.paths.work, job.id, s, `${n}.json`)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, '{}')
      }
    }
    env.handle.sqlite.prepare('UPDATE jobs SET checkpoint = ? WHERE id = ?').run(JSON.stringify({ steps }), job.id)
    r.start()
    const proc = await waitFor(() => r.queue.listProcs(job.id)[0])
    expect(isAlive(proc.pid)).toBe(true)
    expect(fs.existsSync(path.join(env.paths.work, job.id, 'tmp'))).toBe(true)

    expect(r.queue.cancel(job.id).ok).toBe(true)
    await waitFor(() => !r.activeJobIds.includes(job.id))
    await waitFor(() => !isAlive(proc.pid), 5000)
    expect(fs.existsSync(path.join(env.paths.work, job.id, 'tmp'))).toBe(false)
    expect(r.queue.get(job.id)?.state).toBe('cancelled')
    // checkpoints preservados para eventual retomada
    expect(fs.existsSync(path.join(env.paths.work, job.id, 'tts', '4.json'))).toBe(true)
  })

  it('retomar após cancelar continua do checkpoint, sem refazer passos', async () => {
    const r = makeRunner()
    const job = r.queue.enqueue({ kind: 'selftest', payload: { stepMs: 80 } })
    r.start()
    await waitFor(() => r.queue.get(job.id)?.stage === 'tts')
    r.queue.cancel(job.id)
    await waitFor(() => !r.activeJobIds.includes(job.id))
    const before = execLines(job.id)
    expect(r.queue.resume(job.id).ok).toBe(true)
    await waitFor(() => r.queue.get(job.id)?.state === 'done', 20_000)
    const after = execLines(job.id)
    // passos concluídos antes do cancelamento não rodam de novo
    const doneBefore = before.slice(0, -1) // o último pode ter sido interrompido
    for (const k of doneBefore) expect(after.filter((x) => x === k)).toHaveLength(1)
    expect(new Set(after).size).toBe(Object.values(SELFTEST_STEPS).reduce((a, b) => a + b, 0))
  })

  it('NeedsInputError → needs_input com mensagem; sem nova tentativa automática', async () => {
    let calls = 0
    const r = makeRunner({
      handlers: {
        selftest: async (ctx) => {
          calls++
          ctx.enterStage('script')
          throw new NeedsInputError('PROVIDER_REFUSAL', 'O provedor recusou o tema.')
        },
      },
    })
    const job = r.queue.enqueue({ kind: 'selftest', payload: {} })
    r.start()
    const j = await waitFor(() => (r.queue.get(job.id)?.state === 'needs_input' ? r.queue.get(job.id) : null))
    expect(j?.lastError).toEqual({ code: 'PROVIDER_REFUSAL', message: 'O provedor recusou o tema.' })
    await new Promise((res) => setTimeout(res, 200))
    expect(calls).toBe(1)
  })

  it('erro técnico tenta de novo até max_attempts; erro definitivo falha na hora', async () => {
    let calls = 0
    const r = makeRunner({
      handlers: {
        selftest: async (ctx) => {
          calls++
          if ((ctx.job.payload as { fatal?: boolean }).fatal) throw new Error('quebrou')
          throw new JobError('INTERNAL', 'timeout', true)
        },
      },
    })
    const a = r.queue.enqueue({ kind: 'selftest', payload: {}, maxAttempts: 3 })
    r.start()
    const ja = await waitFor(() => (r.queue.get(a.id)?.state === 'failed' ? r.queue.get(a.id) : null))
    expect(ja?.attempt).toBe(3)
    expect(calls).toBe(3)

    const b = r.queue.enqueue({ kind: 'selftest', payload: { fatal: true }, maxAttempts: 3 })
    const jb = await waitFor(() => (r.queue.get(b.id)?.state === 'failed' ? r.queue.get(b.id) : null))
    expect(jb?.attempt).toBe(1)
    expect(jb?.lastError).toMatchObject({ code: 'INTERNAL', message: 'quebrou' })
  })

  it('desligar o runner devolve o job à fila sem gastar tentativa; outro runner termina', async () => {
    const r1 = makeRunner()
    const job = r1.queue.enqueue({ kind: 'selftest', payload: { stepMs: 50 } })
    r1.start()
    await waitFor(() => r1.queue.get(job.id)?.stage === 'images')
    await r1.stop()
    expect(r1.queue.get(job.id)).toMatchObject({ state: 'queued', attempt: 0, lockedBy: null })

    const r2 = makeRunner()
    r2.start()
    await waitFor(() => r2.queue.get(job.id)?.state === 'done', 20_000)
    expect(execLines(job.id).filter((k) => k === 'script:1')).toHaveLength(1)
  })

  it('runner novo recupera órfão de runner morto (heartbeat velho)', async () => {
    const r = makeRunner({ orphanAfterMs: 300 })
    const job = r.queue.enqueue({ kind: 'selftest', payload: { stepMs: 10 } })
    // simula runner morto: job "running" com heartbeat antigo
    env.handle.sqlite
      .prepare("UPDATE jobs SET state='running', locked_by='morto', attempt=1, heartbeat_at=? WHERE id=?")
      .run(Date.now() - 10_000, job.id)
    r.start()
    const j = await waitFor(() => (r.queue.get(job.id)?.state === 'done' ? r.queue.get(job.id) : null))
    expect(j?.attempt).toBe(2)
  })

  it('reaper mata processo filho deixado por runner morto antes de reenfileirar', async () => {
    const r = makeRunner({ orphanAfterMs: 300, handlers: { selftest: async () => undefined } })
    const job = r.queue.enqueue({ kind: 'selftest', payload: {} })
    // "ffmpeg" órfão: processo longo de um runner que morreu
    const stray = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' })
    stray.unref()
    env.handle.sqlite
      .prepare("UPDATE jobs SET state='running', locked_by='morto', attempt=1, heartbeat_at=? WHERE id=?")
      .run(Date.now() - 10_000, job.id)
    r.queue.addProc(job.id, stray.pid!, process.execPath)
    expect(isAlive(stray.pid!)).toBe(true)
    r.start()
    await waitFor(() => r.queue.get(job.id)?.state === 'done')
    await waitFor(() => !isAlive(stray.pid!), 5000)
    expect(r.queue.listProcs(job.id)).toHaveLength(0)
  })
})
