import { and, eq, isNotNull } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MUSIC_MOODS, type MusicMood } from '../../shared/enums'
import type { DbHandle } from '../db'
import { audioAssets } from '../db/schema'
import { JobError } from '../queue/errors'
import { runFfmpeg, type MediaBinaries, type Spawner } from './ffmpeg'

export { MUSIC_MOODS, type MusicMood }
export const MUSIC_LICENSES = ['own', 'cc0', 'public_domain'] as const

export type AudioAssetRow = typeof audioAssets.$inferSelect

/** Acordes (Hz) por clima; 4 acordes × 4 s formam um ciclo de 16 s. */
const CHORDS: Record<MusicMood, number[][]> = {
  calm: [
    [130.81, 164.81, 196.0, 246.94],
    [110.0, 130.81, 164.81, 196.0],
    [87.31, 130.81, 174.61, 220.0],
    [98.0, 146.83, 196.0, 246.94],
  ],
  upbeat: [
    [146.83, 185.0, 220.0, 293.66],
    [123.47, 146.83, 185.0, 246.94],
    [98.0, 146.83, 196.0, 246.94],
    [110.0, 164.81, 220.0, 277.18],
  ],
  dramatic: [
    [110.0, 130.81, 164.81, 220.0],
    [87.31, 130.81, 174.61, 220.0],
    [98.0, 146.83, 196.0, 233.08],
    [82.41, 123.47, 164.81, 207.65],
  ],
  mysterious: [
    [103.83, 123.47, 155.56, 207.65],
    [97.99, 116.54, 146.83, 196.0],
    [92.5, 110.0, 138.59, 185.0],
    [97.99, 123.47, 146.83, 174.61],
  ],
  inspiring: [
    [130.81, 196.0, 261.63, 329.63],
    [146.83, 220.0, 293.66, 349.23],
    [110.0, 164.81, 220.0, 261.63],
    [87.31, 174.61, 261.63, 349.23],
  ],
}

/** Pulso rítmico (Hz) por clima — 0 = pad contínuo. */
const PULSE: Record<MusicMood, number> = { calm: 0, upbeat: 2, dramatic: 0.5, mysterious: 0, inspiring: 1 }

/** Expressão `aevalsrc`: pad de acordes com envelope suave em cada troca. */
export function musicExpression(mood: MusicMood): string {
  const chords = CHORDS[mood]
  const env = `min(1\\,mod(t\\,4)/1.2)*min(1\\,(4-mod(t\\,4))/1.2)`
  const pulse = PULSE[mood] > 0 ? `*(0.65+0.35*sin(2*PI*${PULSE[mood]}*t))` : ''
  const chord = (notes: number[]) => notes.map((f, i) => `${(0.22 / (i + 1)).toFixed(3)}*sin(2*PI*${f}*t)+${(0.05 / (i + 1)).toFixed(3)}*sin(4*PI*${f}*t)`).join('+')
  let expr = `(${chord(chords[3]!)})`
  for (let k = 2; k >= 0; k--) expr = `if(lt(mod(t\\,16)\\,${(k + 1) * 4})\\,(${chord(chords[k]!)})\\,${expr})`
  return `(${expr})*${env}${pulse}*0.5`
}

/**
 * Trilha embutida do MUDO para um clima: sintetizada pelo próprio ffmpeg
 * (licença `own`, sem crédito exigido) e registrada em `audio_assets`.
 */
export async function ensureBuiltinMusic(h: DbHandle, spawn: Spawner, bins: MediaBinaries, dir: string, mood: MusicMood): Promise<AudioAssetRow> {
  const file = path.join(dir, `mudo-${mood}.m4a`)
  const existing = h.db.select().from(audioAssets).where(eq(audioAssets.path, file)).get()
  if (existing && fs.existsSync(file)) return existing
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.part.m4a`
  await runFfmpeg(
    spawn,
    bins,
    [
      '-f', 'lavfi', '-i', `aevalsrc=${musicExpression(mood)}:s=48000:d=64`,
      '-af', 'lowpass=f=2400,aecho=0.8:0.7:120|240:0.3|0.2,afade=t=in:d=1,afade=t=out:st=62:d=2,loudnorm=I=-20:TP=-3',
      '-ac', '2', '-c:a', 'aac', '-b:a', '160k', tmp,
    ],
    { what: `gerar a trilha "${mood}"` },
  )
  fs.renameSync(tmp, file)
  if (existing) return existing
  const row = { id: randomUUID(), kind: 'music', path: file, mood, license: 'own', requiresCredit: false, creditText: null }
  h.db.insert(audioAssets).values(row).run()
  return row
}

/** Importa uma música do usuário (licença obrigatória: sem licença não entra). */
export function importMusic(h: DbHandle, file: string, o: { mood: MusicMood; license: (typeof MUSIC_LICENSES)[number]; credit?: string | null }): AudioAssetRow {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new JobError('INVALID_INPUT', `arquivo não encontrado: ${file}`)
  if (!/\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(abs)) throw new JobError('INVALID_INPUT', 'formato de áudio não suportado')
  const parsed = z.enum(MUSIC_LICENSES).safeParse(o.license)
  if (!parsed.success) throw new JobError('INVALID_INPUT', `licença deve ser ${MUSIC_LICENSES.join(', ')}`)
  const row = {
    id: randomUUID(),
    kind: 'music',
    path: abs,
    mood: o.mood,
    license: parsed.data,
    requiresCredit: !!o.credit?.trim(),
    creditText: o.credit?.trim() || null,
  }
  h.db.insert(audioAssets).values(row).run()
  return row
}

export function listMusic(h: DbHandle): AudioAssetRow[] {
  return h.db.select().from(audioAssets).where(eq(audioAssets.kind, 'music')).all()
}

/** Escolhe a trilha do clima: primeiro as do usuário (com licença), senão a embutida. */
export async function pickMusic(h: DbHandle, spawn: Spawner, bins: MediaBinaries, builtinDir: string, mood: MusicMood, seed: number): Promise<AudioAssetRow> {
  const own = h.db
    .select()
    .from(audioAssets)
    .where(and(eq(audioAssets.kind, 'music'), eq(audioAssets.mood, mood), isNotNull(audioAssets.license)))
    .all()
    .filter((r) => !path.basename(r.path).startsWith('mudo-') && fs.existsSync(r.path) && (!r.requiresCredit || r.creditText))
  if (own.length > 0) return own[seed % own.length]!
  return ensureBuiltinMusic(h, spawn, bins, builtinDir, mood)
}

const loudnormSchema = z.object({
  input_i: z.string(),
  input_tp: z.string(),
  input_lra: z.string(),
  input_thresh: z.string(),
  target_offset: z.string(),
})

export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 } as const

/**
 * Mistura narração + trilha em loop com fade e `sidechaincompress` (a música
 * abaixa sob a voz) e normaliza em duas passadas para −14 LUFS integrados com
 * pico real abaixo de −1 dBTP (seção 8.6).
 */
export async function mixAndNormalize(
  spawn: Spawner,
  bins: MediaBinaries,
  o: { narration: string; music: string; totalS: number; out: string; tmpDir: string; onProgress?: (f: number) => void },
): Promise<{ measuredI: number }> {
  const mix = path.join(o.tmpDir, 'mix.wav')
  const T = o.totalS.toFixed(3)
  const fadeOutStart = Math.max(0, o.totalS - 3).toFixed(3)
  await runFfmpeg(
    spawn,
    bins,
    [
      '-i', o.narration,
      '-stream_loop', '-1', '-i', o.music,
      '-filter_complex',
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${T},asplit=2[voice][key];` +
        `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${T},asetpts=N/SR/TB,volume=0.22,afade=t=in:d=1.5,afade=t=out:st=${fadeOutStart}:d=3[bed];` +
        `[bed][key]sidechaincompress=threshold=0.015:ratio=12:attack=15:release=400:makeup=1:level_sc=3[ducked];` +
        `[voice][ducked]amix=inputs=2:duration=first:normalize=0[out]`,
      '-map', '[out]', '-t', T, '-c:a', 'pcm_s16le', '-ar', '48000', mix,
    ],
    { what: 'misturar narração e trilha', expectedS: o.totalS, onProgress: (f) => o.onProgress?.(f * 0.4) },
  )

  let measured = ''
  const r1 = await spawn(bins.ffmpeg, ['-hide_banner', '-nostdin', '-i', mix, '-af', `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:print_format=json`, '-f', 'null', '-'], {
    onStderrLine: (l) => {
      measured += `${l}\n`
    },
  })
  if (r1.code !== 0) throw new JobError('FFMPEG_FAILED', 'ffmpeg falhou ao medir a loudness (1ª passada).', false, { stderr: r1.stderrTail })
  o.onProgress?.(0.7)
  const json = /\{[^{}]*"input_i"[^{}]*\}/s.exec(measured)?.[0]
  if (!json) throw new JobError('FFMPEG_FAILED', 'não foi possível ler a medição de loudness')
  const m = loudnormSchema.parse(JSON.parse(json))
  await runFfmpeg(
    spawn,
    bins,
    [
      '-i', mix,
      '-af',
      `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
      '-c:a', 'pcm_s16le', '-ar', '48000', o.out,
    ],
    { what: 'normalizar a loudness (2ª passada)', expectedS: o.totalS, onProgress: (f) => o.onProgress?.(0.7 + f * 0.3) },
  )
  fs.rmSync(mix, { force: true })
  return { measuredI: Number(m.input_i) }
}
