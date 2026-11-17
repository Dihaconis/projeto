import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JobQueue,
  Runner,
  createChannel,
  createVideoJob,
  jobHandlers,
  nullLogger,
  resolveMediaBinaries,
  setSetting,
  type ProviderSource,
} from '../../src/core'
import { makeEnv, waitFor, type TestEnv } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureTts, type FixtureLog } from '../helpers/fixtures'

let env: TestEnv
const runners: Runner[] = []
beforeEach(() => {
  env = makeEnv()
  setSetting(env.handle, 'output.dir', path.join(env.paths.root, 'saída'))
})
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop()
  env.cleanup()
})

function start(providers: ProviderSource) {
  const r = new Runner({
    handle: env.handle,
    paths: env.paths,
    log: nullLogger(),
    handlers: jobHandlers,
    providers,
    media: resolveMediaBinaries(),
    pollMs: 20,
    heartbeatMs: 200,
  })
  runners.push(r)
  r.start()
  return r
}

const until = (q: JobQueue, id: string, states: string[]) =>
  waitFor(() => {
    const j = q.get(id)
    return j && states.includes(j.state) ? j : null
  }, 90_000)

describe('pipeline de vídeo', () => {
  it('revisão reprova 2× → needs_input com as issues; retomar libera e termina', async () => {
    const log: FixtureLog = { calls: [] }
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const { job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm('llm', log, { review: 'llm/review-rejected.json' })], [fixtureTts()]))
    const j = await until(r.queue, job.id, ['needs_input', 'failed', 'done'])
    expect(j.state).toBe('needs_input')
    expect(j.stage).toBe('review')
    expect(j.lastError).toMatchObject({ code: 'REVIEW_REJECTED' })
    expect((j.lastError as { message: string }).message).toContain('ato 4')
    expect(log.calls.filter((c) => c.kind === 'review')).toHaveLength(2)

    r.queue.resume(job.id)
    const done = await until(r.queue, job.id, ['done', 'failed', 'needs_input'])
    expect(done.state).toBe('done')
    expect(log.calls.filter((c) => c.kind === 'review')).toHaveLength(2) // decisão humana, sem nova revisão
    expect(log.calls.filter((c) => c.kind === 'script')).toHaveLength(1)
  }, 120_000)

  it('canal com revisão manual para em needs_input mesmo aprovado', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR', stylePreset: { manualReview: true } })
    const { job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm()], [fixtureTts()]))
    const j = await until(r.queue, job.id, ['needs_input', 'failed', 'done'])
    expect(j.lastError).toMatchObject({ code: 'REVIEW_MANUAL' })
  }, 60_000)

  it('imagem que exige crédito sem texto de crédito → LICENSE_MISSING antes da montagem (critério 4)', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const { job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    let tampered = false
    const tts = fixtureTts('tts', undefined, {
      onCall: () => {
        if (tampered) return
        tampered = true
        env.handle.sqlite.prepare('UPDATE images SET requires_credit = 1, credit_text = NULL').run()
      },
    })
    const r = start(fixtureSource([fixtureLlm()], [tts]))
    const j = await until(r.queue, job.id, ['needs_input', 'failed', 'done'])
    expect(j.state).toBe('failed')
    expect(j.stage).toBe('assemble')
    expect(j.lastError).toMatchObject({ code: 'LICENSE_MISSING' })
    expect(env.handle.sqlite.prepare('SELECT output_path FROM videos').get()).toEqual({ output_path: null })
  }, 90_000)

  it('narração um pouco longa → atempo dentro de ±8%; longa demais → needs_input', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const a = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm()], [fixtureTts('tts', undefined, { wpm: 125 })]))
    const ja = await until(r.queue, a.job.id, ['needs_input', 'failed', 'done'])
    expect(ja.state).toBe('done')
    const cp = ja.checkpoint as { narration: { tempo: number; totalMs: number } }
    expect(cp.narration.tempo).toBeGreaterThan(1)
    expect(cp.narration.tempo).toBeLessThanOrEqual(1.08 * 1.002)
    expect(cp.narration.totalMs / 1000).toBeLessThanOrEqual(69.01)
    await r.stop()

    const b = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r2 = start(fixtureSource([fixtureLlm()], [fixtureTts('tts', undefined, { wpm: 90 })]))
    const jb = await until(r2.queue, b.job.id, ['needs_input', 'failed', 'done'])
    expect(jb.state).toBe('needs_input')
    expect(jb.lastError).toMatchObject({ code: 'DURATION_OUT_OF_RANGE' })
  }, 180_000)
})
