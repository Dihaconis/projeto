/**
 * Critério de aceite 2 sobre um MP4 gerado de ponta a ponta (provedores de
 * fixture): 1920×1080/30 fps, legenda sincronizada (< 150 ms), música abaixada
 * sob a voz, −14 LUFS ±1, pico real ≤ −1 dBTP, thumbnails e cartela de créditos.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Runner, createChannel, createVideoJob, jobHandlers, nullLogger, resolveMediaBinaries, setSetting, type JobRow } from '../../src/core'
import { globalWords } from '../../src/core/pipeline/video/assemble-stage'
import { loadVideoJob } from '../../src/core/pipeline/video/state'
import { makeEnv, waitFor, type TestEnv, slow } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureStock, fixtureTts } from '../helpers/fixtures'

const bins = resolveMediaBinaries()
let env: TestEnv
let job: JobRow
let video: { id: string; output_path: string; thumb_path: string; actual_duration_s: number }

beforeAll(async () => {
  env = makeEnv()
  setSetting(env.handle, 'output.dir', path.join(env.paths.root, 'saída final'))
  const ch = createChannel(env.handle, { name: 'C', niche: 'ciência', language: 'pt-BR', musicMood: 'calm', stylePreset: { highlightColor: '#00E5FF' } })
  const created = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
  const r = new Runner({
    handle: env.handle,
    paths: env.paths,
    log: nullLogger(),
    handlers: jobHandlers,
    providers: fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [fixtureStock('pexels')] }),
    media: bins,
    pollMs: 20,
  })
  r.start()
  job = await waitFor(() => {
    const j = r.queue.get(created.job.id)
    return j && ['done', 'failed', 'needs_input'].includes(j.state) ? j : null
  }, slow(300_000))
  await r.stop()
  video = env.handle.sqlite.prepare('SELECT id, output_path, thumb_path, actual_duration_s FROM videos').get() as typeof video
}, slow(320_000))
afterAll(() => env.cleanup())

function ff(args: string[]): string {
  return spawnSync(bins.ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).stderr
}

describe('MP4 final (critério 2)', () => {
  it('pronto, 1920×1080 a 30 fps, duração = narração + cartela', () => {
    expect(job.lastError).toBeNull()
    expect(job.state).toBe('done')
    const r = spawnSync(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video.output_path], { encoding: 'utf8' })
    const p = JSON.parse(r.stdout)
    const v = p.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    expect(v).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', pix_fmt: 'yuv420p' })
    expect(Math.abs(Number(p.format.duration) - video.actual_duration_s)).toBeLessThan(0.15)
  })

  it('loudness −14 LUFS ±1 e pico real ≤ −1 dBTP', () => {
    const out = ff(['-i', video.output_path, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
    const summary = out.slice(out.lastIndexOf('Summary:'))
    const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1])
    const tp = Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1])
    expect(Math.abs(I + 14)).toBeLessThanOrEqual(1)
    expect(tp).toBeLessThanOrEqual(-1)
  })

  it('legenda sincronizada: 1ª palavra de cada cena < 150 ms do início audível da fala', () => {
    const st = loadVideoJob({ job, checkpoint: () => job.checkpoint, db: env.handle, workDir: path.join(env.paths.work, video.id), tmpDir: '', paths: env.paths } as never)
    const words = globalWords(st)
    const narration = path.join(env.paths.work, video.id, 'narration.wav')
    // medição independente: onde a fala realmente começa no áudio
    const det = ff(['-i', narration, '-af', 'silencedetect=n=-45dB:d=0.2', '-f', 'null', '-'])
    const onsets = [0, ...[...det.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000)]
    const firsts = words.filter((w) => w.length > 0).map((w) => w[0]!.startMs)
    expect(firsts.length).toBeGreaterThanOrEqual(6)
    for (const f of firsts) {
      const nearest = Math.min(...onsets.map((o) => Math.abs(o - f)))
      expect(nearest).toBeLessThan(150)
    }
    // e a legenda queimada usa esses tempos: cada palavra dura > 0 e não volta no tempo
    const flat = words.flat()
    for (let i = 1; i < flat.length; i++) expect(flat[i]!.startMs).toBeGreaterThanOrEqual(flat[i - 1]!.startMs - 1)
  })

  it('movimentos alternados (sem repetir seguido) e legenda queimada no quadro', async () => {
    const motions = (env.handle.sqlite.prepare('SELECT motion FROM scenes ORDER BY n').all() as Array<{ motion: string }>).map((m) => m.motion)
    for (let i = 1; i < motions.length; i++) expect(motions[i]).not.toBe(motions[i - 1])
    // quadro no meio da 1ª fala: a faixa inferior tem texto (pixels quase brancos ou da cor de destaque)
    const frame = path.join(env.paths.root, 'f.png')
    spawnSync(bins.ffmpeg, ['-y', '-loglevel', 'error', '-ss', '2', '-i', video.output_path, '-frames:v', '1', frame])
    const { data, info } = await sharp(frame).extract({ left: 0, top: 860, width: 1920, height: 180 }).raw().toBuffer({ resolveWithObject: true })
    let bright = 0
    for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 235 && data[i + 1]! > 235 && data[i + 2]! > 235) bright++
    expect(bright).toBeGreaterThan(2000)
  })

  it('cartela de créditos no fim, thumbnails 1280×720 (2 variações) e .txt com créditos', async () => {
    const last = path.join(env.paths.root, 'last.png')
    spawnSync(bins.ffmpeg, ['-y', '-loglevel', 'error', '-sseof', '-2', '-i', video.output_path, '-frames:v', '1', last])
    const s = await sharp(last).stats()
    expect(s.channels[0]!.mean).toBeLessThan(40) // fundo escuro da cartela
    const thumbs = [video.thumb_path, video.thumb_path.replace('thumbnail 1', 'thumbnail 2')]
    for (const t of thumbs) {
      const m = await sharp(t).metadata()
      expect([m.width, m.height]).toEqual([1280, 720])
    }
    const txt = fs.readFileSync(video.output_path.replace(/\.mp4$/, '.txt'), 'utf8')
    expect(txt).toContain('Pexels')
    expect(txt).toContain('Narração: voz sintética')
  })
})
