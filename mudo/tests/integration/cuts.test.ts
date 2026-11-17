/**
 * Cortes (Beta, seção 11.3): autorização obrigatória, transcrição real
 * (whisper.cpp sobre fala de domínio público), trechos com nota e justificativa,
 * exportação 9:16 com legenda, cota de cortes e download por link (yt-dlp).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  JobQueue,
  Runner,
  createCutJob,
  enqueueCutExport,
  getCutDetail,
  jobHandlers,
  nullLogger,
  quotaStatus,
  resolveMediaBinaries,
  setPlan,
  setSetting,
  consumeQuota,
  type ProviderSource,
} from '../../src/core'
import { sentencesFromWords } from '../../src/core/pipeline/cut'
import { makeEnv, tempRoot, waitFor, type TestEnv } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureTts } from '../helpers/fixtures'

const bins = resolveMediaBinaries()
let sample: string
let env: TestEnv
const providers: ProviderSource = fixtureSource([fixtureLlm()], [fixtureTts()])

beforeAll(() => {
  // vídeo 16:9 de ~35 s com fala real: a amostra de domínio público 3× com pausas
  const dir = tempRoot('mudo cortes amostra ')
  sample = path.join(dir, 'minha palestra.mp4')
  const jfk = path.resolve(__dirname, '../fixtures/audio/jfk.wav')
  const r = spawnSync(bins.ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=36',
    '-i', jfk, '-i', jfk, '-i', jfk,
    '-filter_complex', '[1:a]apad=pad_dur=1[a1];[2:a]apad=pad_dur=1[a2];[3:a][a1][a2]concat=n=3:v=0:a=1[a]',
    '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sample,
  ])
  if (r.status !== 0) throw new Error(r.stderr.toString())
})

beforeEach(() => {
  env = makeEnv()
  setSetting(env.handle, 'output.dir', path.join(env.paths.root, 'saída'))
})
afterEach(() => env.cleanup())

async function run(jobId: string) {
  const r = new Runner({ handle: env.handle, paths: env.paths, log: nullLogger(), handlers: jobHandlers, providers, media: bins, pollMs: 20 })
  r.start()
  const j = await waitFor(() => {
    const x = r.queue.get(jobId)
    return x && ['done', 'failed', 'needs_input'].includes(x.state) ? x : null
  }, 240_000)
  await r.stop()
  return j
}

describe('Cortes (Beta)', () => {
  it('sem a confirmação de autorização nada é criado; link e arquivo inválidos recusados', () => {
    expect(() => createCutJob(env.handle, { source: sample, authorized: false })).toThrow(/autorização/)
    expect(() => createCutJob(env.handle, { source: '/nao/existe.mp4', authorized: true })).toThrow(/não encontrado/)
    expect(() => createCutJob(env.handle, { source: path.resolve(__dirname, '../fixtures/audio/README.md'), authorized: true })).toThrow(/formato/)
    expect(env.handle.sqlite.prepare('SELECT COUNT(*) n FROM cuts').get()).toEqual({ n: 0 })
  })

  it('arquivo local → transcrição → trechos com nota/justificativa → exportação 9:16 com legenda; cota de cortes', async () => {
    const { cut, job } = createCutJob(env.handle, { source: sample, authorized: true })
    const analysed = await run(job.id)
    expect(analysed.lastError).toBeNull()
    expect(analysed.state).toBe('done')
    const d = getCutDetail(env.handle, cut.id)
    expect(d.cut.durationS).toBeGreaterThan(30)
    expect(d.transcript.map((w) => w.word.toLowerCase()).join(' ')).toContain('country')
    expect(d.highlights.length).toBeGreaterThanOrEqual(1)
    for (const h of d.highlights) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(100)
      expect(h.reason.length).toBeGreaterThan(5)
      expect((h.endMs - h.startMs) / 1000).toBeGreaterThanOrEqual(15)
    }

    setPlan(env.handle, 'inicial')
    const best = d.highlights[0]!
    const ex = enqueueCutExport(env.handle, best.id)
    expect(enqueueCutExport(env.handle, best.id).id).toBe(ex.id) // não duplica
    const done = await run(ex.id)
    expect(done.state).toBe('done')
    const out = getCutDetail(env.handle, cut.id).highlights.find((h) => h.id === best.id)!.exportedPath!
    expect(path.dirname(out).endsWith('Cortes')).toBe(true)
    const p = JSON.parse(spawnSync(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8' }).stdout)
    const v = p.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    expect([v.width, v.height]).toEqual([1080, 1920])
    expect(Math.abs(Number(p.format.duration) - (best.endMs - best.startMs) / 1000)).toBeLessThan(0.3)
    expect(p.format.tags.comment).toContain('IA')
    // legenda queimada na faixa inferior
    const frame = path.join(env.paths.root, 'f.png')
    spawnSync(bins.ffmpeg, ['-y', '-loglevel', 'error', '-ss', '3', '-i', out, '-frames:v', '1', frame])
    const { data, info } = await sharp(frame).extract({ left: 0, top: 1300, width: 1080, height: 300 }).raw().toBuffer({ resolveWithObject: true })
    let bright = 0
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 240 && data[i + 1]! > 240 && data[i + 2]! > 240) bright++
    expect(bright).toBeGreaterThan(500)
    expect(quotaStatus(env.handle).cutsUsed).toBe(1)

    // cota de cortes esgotada recusa antes de enfileirar
    for (let i = 0; i < 4; i++) consumeQuota(env.handle, 'cut')
    const other = getCutDetail(env.handle, cut.id).highlights.find((h) => h.id !== best.id)
    if (other) expect(() => enqueueCutExport(env.handle, other.id)).toThrow(/esgotada/)
  }, 400_000)

  it('link: baixa com yt-dlp (servidor local) e segue a análise', async () => {
    const server = http.createServer((req, res) => {
      const stat = fs.statSync(sample)
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': stat.size })
      fs.createReadStream(sample).pipe(res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/palestra.mp4`
      const { cut, job } = createCutJob(env.handle, { source: url, authorized: true })
      const j = await run(job.id)
      expect(j.lastError).toBeNull()
      const row = env.handle.sqlite.prepare('SELECT media_path, duration_s FROM cuts WHERE id = ?').get(cut.id) as { media_path: string; duration_s: number }
      expect(fs.existsSync(row.media_path)).toBe(true)
      expect(row.duration_s).toBeGreaterThan(30)
      expect(new JobQueue(env.handle).get(job.id)?.state).toBe('done')
    } finally {
      server.close()
    }
  }, 400_000)

  it('frases para o analista: pontuação, pausa longa e limite de 25 s', () => {
    const w = (word: string, s: number, e: number) => ({ word, startMs: s, endMs: e })
    const out = sentencesFromWords([w('Olá', 0, 300), w('mundo.', 300, 600), w('Depois', 2000, 2300), w('da', 2300, 2400), w('pausa', 2400, 2700)])
    expect(out.map((s) => s.text)).toEqual(['Olá mundo.', 'Depois da pausa'])
  })
})
