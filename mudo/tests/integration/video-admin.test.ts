import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  JobQueue,
  Runner,
  createChannel,
  createVideoJob,
  deleteVideo,
  getScriptForEdit,
  jobHandlers,
  listVideoViews,
  nullLogger,
  resolveMediaBinaries,
  saveEditedScript,
  setSetting,
  videoMediaPath,
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

async function runUntil(providers: ProviderSource, jobId: string) {
  const r = new Runner({ handle: env.handle, paths: env.paths, log: nullLogger(), handlers: jobHandlers, providers, media: resolveMediaBinaries(), pollMs: 20 })
  runners.push(r)
  r.start()
  const j = await waitFor(() => {
    const x = r.queue.get(jobId)
    return x && ['done', 'failed', 'needs_input'].includes(x.state) ? x : null
  }, 180_000)
  await r.stop()
  runners.splice(runners.indexOf(r), 1)
  return j
}

describe('telas Meus Vídeos/Biblioteca (core)', () => {
  it('editar roteiro em needs_input invalida cenas/narração, marca revisão humana e a geração termina com o texto novo', async () => {
    const log: FixtureLog = { calls: [] }
    const ch = createChannel(env.handle, { name: 'Canal', niche: 'ciência', language: 'pt-BR' })
    const { video, job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const j = await runUntil(fixtureSource([fixtureLlm('llm', log, { review: 'llm/review-rejected.json' })], [fixtureTts()]), job.id)
    expect(j.state).toBe('needs_input')

    const s = getScriptForEdit(env.handle, env.paths, video.id)
    expect(s.editable).toBe(true)
    expect(s.acts).toHaveLength(5)
    expect(s.issues.map((i) => i.kind)).toContain('factual')
    expect(s.targetWords).toBe(150)

    const edited = s.acts.map((a, i) => (i === 0 ? { ...a, text: 'Você já reparou que o céu muda de cor? Hoje você vai entender por que ele fica azul.' } : a))
    const after = saveEditedScript(env.handle, env.paths, video.id, edited)
    expect(after.acts[0]!.text).toContain('muda de cor')
    const cp = new JobQueue(env.handle).get(job.id)!.checkpoint as { review: { status: string } }
    expect(cp.review.status).toBe('human')
    expect(() => saveEditedScript(env.handle, env.paths, video.id, edited.slice(0, 3))).toThrow(/5 a 7 atos/)

    new JobQueue(env.handle).resume(job.id)
    const done = await runUntil(fixtureSource([fixtureLlm('llm', log)], [fixtureTts()]), job.id)
    expect(done.state).toBe('done')
    const firstScene = env.handle.sqlite.prepare('SELECT text FROM scenes WHERE video_id = ? ORDER BY n LIMIT 1').get(video.id) as { text: string }
    expect(firstScene.text).toContain('muda de cor')
    expect(log.calls.filter((c) => c.kind === 'review')).toHaveLength(2) // a edição não pediu nova revisão

    // com a geração terminada, o roteiro não é mais editável
    expect(getScriptForEdit(env.handle, env.paths, video.id).editable).toBe(false)
    expect(() => saveEditedScript(env.handle, env.paths, video.id, edited)).toThrow()

    // lista e mídia
    const views = listVideoViews(env.handle, { onlyDone: true })
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: video.id, state: 'done', hasOutput: true, hasThumb: true, channelName: 'Canal' })
    expect(videoMediaPath(env.handle, video.id, 'video')).toMatch(/\.mp4$/)
    expect(videoMediaPath(env.handle, video.id, 'thumb2')).toMatch(/thumbnail 2\.jpg$/)
    expect(videoMediaPath(env.handle, 'nao-existe', 'video')).toBeNull()

    // apagar remove registros e arquivos
    const out = videoMediaPath(env.handle, video.id, 'video')!
    deleteVideo(env.handle, env.paths, video.id)
    expect(fs.existsSync(out)).toBe(false)
    expect(fs.existsSync(out.replace(/\.mp4$/, '.txt'))).toBe(false)
    expect(fs.existsSync(path.join(env.paths.work, video.id))).toBe(false)
    expect(listVideoViews(env.handle)).toHaveLength(0)
    expect(env.handle.sqlite.prepare('SELECT COUNT(*) n FROM scenes').get()).toEqual({ n: 0 })
  }, 300_000)

  it('não apaga vídeo em geração', () => {
    const ch = createChannel(env.handle, { name: 'Canal', niche: 'ciência', language: 'pt-BR' })
    const { video } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Tema qualquer', durationS: 60 })
    new JobQueue(env.handle).claim('r1')
    expect(() => deleteVideo(env.handle, env.paths, video.id)).toThrow(/Cancele/)
  })
})
