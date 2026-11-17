import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobQueue } from '../../src/core'
import { SELFTEST_STEPS } from '../helpers/selftest-handler'
import { isAlive, makeEnv, waitFor, type TestEnv, slow } from '../helpers/env'

const CHILD = path.resolve(__dirname, '../helpers/runner-child.ts')
const children: ChildProcess[] = []
let env: TestEnv | undefined

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  env?.cleanup()
  env = undefined
})

function startRunner(root: string, orphanMs: number): ChildProcess {
  const c = spawn(process.execPath, ['--import', 'tsx', CHILD, root, String(orphanMs)], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(c)
  return c
}

describe('sobrevive a matar o processo (kill -9) durante a montagem', () => {
  it('retoma do último segmento renderizado sem refazer etapas anteriores', async () => {
    env = makeEnv()
    const q = new JobQueue(env.handle)
    const job = q.enqueue({ kind: 'video', payload: { stepMs: 400 } })
    const orphanMs = 1500

    const first = startRunner(env.paths.root, orphanMs)
    // espera o 2º segmento da montagem começar (1º já salvo) com o filho vivo
    const proc = await waitFor(() => {
      const j = q.get(job.id)
      const cp = j?.checkpoint as { steps?: Record<string, true> } | undefined
      const p = q.listProcs(job.id)[0]
      return j?.stage === 'assemble' && cp?.steps?.['assemble:1'] && p ? p : null
    }, slow(25_000))
    first.kill('SIGKILL')
    await waitFor(() => first.exitCode !== null || first.signalCode !== null)

    // estado deixado pelo crash: job "running" e processo filho órfão
    expect(q.get(job.id)?.state).toBe('running')
    const cpAtKill = q.get(job.id)!.checkpoint as { steps: Record<string, true> }

    const second = startRunner(env.paths.root, orphanMs)
    const done = await waitFor(() => (q.get(job.id)?.state === 'done' ? q.get(job.id) : null), 30_000)
    second.kill('SIGKILL')

    expect(done!.attempt).toBe(2)
    expect(isAlive(proc.pid)).toBe(false)

    const lines = fs.readFileSync(path.join(env.paths.work, job.id, 'exec.log'), 'utf8').trim().split('\n')
    // tudo que estava no checkpoint no momento do kill rodou exatamente uma vez
    for (const k of Object.keys(cpAtKill.steps)) expect(lines.filter((l) => l === k)).toHaveLength(1)
    for (const s of ['script', 'review', 'images', 'tts']) {
      for (let n = 1; n <= SELFTEST_STEPS[s as keyof typeof SELFTEST_STEPS]; n++) {
        expect(lines.filter((l) => l === `${s}:${n}`)).toHaveLength(1)
      }
    }
    expect(new Set(lines).size).toBe(Object.values(SELFTEST_STEPS).reduce((a: number, b: number) => a + b, 0))
    for (let n = 1; n <= SELFTEST_STEPS.assemble; n++) {
      expect(fs.existsSync(path.join(env.paths.work, job.id, 'assemble', `${n}.json`))).toBe(true)
    }
  }, slow(60_000))
})
