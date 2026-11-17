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

describe('imagens por cena (8.4)', () => {
  const rowsOf = () =>
    env.handle.sqlite
      .prepare('SELECT s.n, s.image_query q, i.id, i.source, i.license, i.phash, i.credit_text FROM scenes s JOIN images i ON i.id = s.image_id ORDER BY s.n')
      .all() as Array<{ n: number; q: string; id: string; source: string; license: string; phash: string; credit_text: string | null }>

  it('acervo primeiro; depois banco de imagens; nunca repete (id nem pHash); créditos no .txt', async () => {
    const { importImageFile } = await import('../../src/core/images/library')
    const { fixtureEmbeddings, fixtureStock, noiseImage } = await import('../helpers/fixtures')
    const fs = await import('node:fs')
    const dir = path.join(env.paths.root, 'acervo')
    fs.mkdirSync(dir)
    for (const name of ['clear blue sky over a field', 'sunlight through clouds', 'ocean waves at sea']) {
      const f = path.join(dir, `${name}.jpg`)
      fs.writeFileSync(f, await noiseImage(name, 1920, 1080))
      await importImageFile(env.handle, fixtureEmbeddings, f, { license: 'own' })
    }
    const log = { searches: [] as string[], downloads: [] as string[] }
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const { job, video } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [fixtureStock('pexels', log)] }))
    const j = await until(r.queue, job.id, ['done', 'failed', 'needs_input'])
    expect(j.lastError).toBeNull()
    const rows = rowsOf()
    expect(new Set(rows.map((x) => x.id)).size).toBe(rows.length)
    for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) expect(rows[a]!.phash === rows[b]!.phash).toBe(false)
    const lib = rows.filter((x) => x.source === 'library')
    expect(lib).toHaveLength(3) // cada imagem do acervo usada uma vez
    expect(rows.filter((x) => x.source === 'pexels')).toHaveLength(rows.length - 3)
    expect(rows.every((x) => x.license)).toBe(true)
    // só o que foi usado é baixado em tamanho cheio
    expect(log.downloads.filter((u) => u.endsWith('/full'))).toHaveLength(rows.length - 3)
    // largura < 1280 nunca é baixada
    expect(log.downloads.some((u) => /-3\/(full|preview)$/.test(u))).toBe(false)

    const credits = env.handle.sqlite.prepare('SELECT text FROM credits WHERE video_id = ? ORDER BY position').all(video.id) as Array<{ text: string }>
    expect(credits.length).toBe(rows.length - 3)
    expect(credits[0]!.text).toContain('Pexels')
    const out = env.handle.sqlite.prepare('SELECT output_path FROM videos WHERE id = ?').get(video.id) as { output_path: string }
    const txt = fs.readFileSync(out.output_path.replace(/\.mp4$/, '.txt'), 'utf8')
    expect(txt).toContain(credits[0]!.text)
  }, 120_000)

  it('Pexels com chave inválida → Pixabay; sem bancos e acervo vazio → geração por IA', async () => {
    const { fixtureStock, fixtureImageGen } = await import('../helpers/fixtures')
    const { ProviderTechnicalError } = await import('../../src/core')
    const broken = { ...fixtureStock('pexels'), call: async () => Promise.reject(new ProviderTechnicalError('pexels', 'pexels: chave inválida (HTTP 401)', false, 401)) }
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const a = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [broken, fixtureStock('pixabay')] }))
    expect((await until(r.queue, a.job.id, ['done', 'failed', 'needs_input'])).state).toBe('done')
    expect(new Set(rowsOf().map((x) => x.source))).toEqual(new Set(['pixabay']))
    await r.stop()

    env.handle.sqlite.exec('DELETE FROM credits; DELETE FROM scenes; DELETE FROM images;')
    const genLog: string[] = []
    const b = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r2 = start(fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [], gen: [fixtureImageGen(genLog)] }))
    expect((await until(r2.queue, b.job.id, ['done', 'failed', 'needs_input'])).state).toBe('done')
    const rows = rowsOf()
    expect(new Set(rows.map((x) => x.license))).toEqual(new Set(['generated']))
    expect(genLog[0]).toContain('no text, no logos')
  }, 180_000)

  it('nenhuma fonte de imagem → needs_input IMAGES_UNAVAILABLE com instrução', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR' })
    const { job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const r = start(fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [], gen: [] }))
    const j = await until(r.queue, job.id, ['done', 'failed', 'needs_input'])
    expect(j.state).toBe('needs_input')
    expect(j.stage).toBe('images')
    expect(j.lastError).toMatchObject({ code: 'IMAGES_UNAVAILABLE' })
    expect((j.lastError as { message: string }).message).toContain('mudo images import')
  }, 60_000)
})
