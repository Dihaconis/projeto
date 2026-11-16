import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobQueue, openDatabase } from '../../src/core'
import { makeEnv, type TestEnv } from '../helpers/env'

let env: TestEnv
let now = 1_000_000
const clock = () => now

beforeEach(() => {
  env = makeEnv()
  now = 1_000_000
})
afterEach(() => env.cleanup())

describe('JobQueue', () => {
  it('enfileira e reivindica em ordem de criação, incrementando a tentativa', () => {
    const q = new JobQueue(env.handle, clock)
    const a = q.enqueue({ kind: 'selftest', payload: {} })
    now++
    const b = q.enqueue({ kind: 'selftest', payload: {} })
    expect(a.state).toBe('queued')

    const c1 = q.claim('r1')
    const c2 = q.claim('r1')
    expect(c1?.id).toBe(a.id)
    expect(c2?.id).toBe(b.id)
    expect(c1?.state).toBe('running')
    expect(c1?.attempt).toBe(1)
    expect(c1?.lockedBy).toBe('r1')
    expect(q.claim('r1')).toBeNull()
  })

  it('dois processos (conexões) nunca pegam o mesmo job', () => {
    const q1 = new JobQueue(env.handle, clock)
    const other = openDatabase(env.paths.db)
    const q2 = new JobQueue(other, clock)
    for (let i = 0; i < 20; i++) {
      q1.enqueue({ kind: 'selftest', payload: {} })
      now++
    }
    const got = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const j = (i % 2 === 0 ? q1 : q2).claim(i % 2 === 0 ? 'r1' : 'r2')
      expect(j).not.toBeNull()
      expect(got.has(j!.id)).toBe(false)
      got.add(j!.id)
    }
    expect(got.size).toBe(20)
    other.close()
  })

  it('escritas do runner exigem posse; cancelar tira a posse', () => {
    const q = new JobQueue(env.handle, clock)
    const j = q.enqueue({ kind: 'selftest', payload: {} })
    q.claim('r1')
    expect(q.heartbeat(j.id, 'r1')).toBe(true)
    expect(q.heartbeat(j.id, 'outro')).toBe(false)
    expect(q.update(j.id, 'r1', { stage: 'script', progress: 0.2 })).toBe(true)

    const c = q.cancel(j.id)
    expect(c).toMatchObject({ ok: true, wasRunning: true })
    expect(q.get(j.id)?.state).toBe('cancelled')
    expect(q.heartbeat(j.id, 'r1')).toBe(false)
    expect(q.update(j.id, 'r1', { progress: 0.9 })).toBe(false)
    expect(q.finish(j.id, 'r1', { state: 'done' })).toBe(false)
    expect(q.get(j.id)?.state).toBe('cancelled')
    expect(q.get(j.id)?.progress).toBeCloseTo(0.2)
  })

  it('não cancela job pronto e retoma cancelado/falho/needs_input do checkpoint', () => {
    const q = new JobQueue(env.handle, clock)
    const j = q.enqueue({ kind: 'selftest', payload: {} })
    q.claim('r1')
    q.update(j.id, 'r1', { checkpoint: { steps: { 'script:1': true } } })
    q.finish(j.id, 'r1', { state: 'needs_input', error: { code: 'PROVIDER_REFUSAL', message: 'recusado' } })
    expect(q.get(j.id)?.state).toBe('needs_input')
    expect(q.get(j.id)?.lastError).toMatchObject({ code: 'PROVIDER_REFUSAL' })

    expect(q.resume(j.id).ok).toBe(true)
    const r = q.get(j.id)!
    expect(r).toMatchObject({ state: 'queued', attempt: 0, lastError: null })
    expect(r.checkpoint).toEqual({ steps: { 'script:1': true } })

    q.claim('r1')
    q.finish(j.id, 'r1', { state: 'done' })
    expect(q.cancel(j.id).ok).toBe(false)
    expect(q.resume(j.id).ok).toBe(false)
    expect(q.get(j.id)?.state).toBe('done')
  })

  it('devolução por desligamento não gasta tentativa', () => {
    const q = new JobQueue(env.handle, clock)
    const j = q.enqueue({ kind: 'selftest', payload: {} })
    q.claim('r1')
    q.finish(j.id, 'r1', { state: 'queued', countAttempt: false })
    expect(q.get(j.id)).toMatchObject({ state: 'queued', attempt: 0, lockedBy: null })
    q.claim('r1')
    q.finish(j.id, 'r1', { state: 'queued', countAttempt: true })
    expect(q.get(j.id)?.attempt).toBe(1)
  })

  it('órfão: heartbeat > limite volta para a fila; esgotou tentativas → failed', () => {
    const q = new JobQueue(env.handle, clock)
    const j = q.enqueue({ kind: 'selftest', payload: {}, maxAttempts: 2 })
    q.claim('morto')
    now += 59_000
    expect(q.findOrphans(60_000)).toHaveLength(0)
    now += 2_000
    expect(q.findOrphans(60_000).map((o) => o.id)).toEqual([j.id])
    expect(q.recoverOrphan(j.id, 60_000)).toBe('requeued')
    expect(q.get(j.id)).toMatchObject({ state: 'queued', lockedBy: null, attempt: 1 })

    q.claim('morto2')
    expect(q.recoverOrphan(j.id, 60_000)).toBe('skipped') // heartbeat fresco
    now += 61_000
    expect(q.recoverOrphan(j.id, 60_000)).toBe('failed')
    expect(q.get(j.id)?.lastError).toMatchObject({ code: 'ORPHAN_MAX_ATTEMPTS' })
  })

  it('registra e lista processos filhos por job', () => {
    const q = new JobQueue(env.handle, clock)
    const j = q.enqueue({ kind: 'selftest', payload: {} })
    q.addProc(j.id, 1234, 'ffmpeg')
    q.addProc(j.id, 1234, 'ffmpeg')
    expect(q.listProcs(j.id)).toHaveLength(1)
    expect(q.strayProcs()).toHaveLength(1) // job não está rodando
    q.removeProc(j.id, 1234)
    expect(q.listProcs(j.id)).toHaveLength(0)
  })
})
