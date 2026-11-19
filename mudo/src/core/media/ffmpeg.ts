import fs from 'node:fs'
import path from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { z } from 'zod'
import { JobError } from '../queue/errors'
import type { SpawnOptions, SpawnResult } from '../proc/spawn'

export interface MediaBinaries {
  ffmpeg: string
  ffprobe: string
  /** whisper.cpp (`whisper-cli`) para alinhar a legenda quando o TTS não dá timestamps. */
  whisper: string | null
  /** Modelo `ggml-base.bin` do whisper.cpp. */
  whisperModel: string | null
  /** Fontes embarcadas (licença OFL) para legenda, thumbnail e cartela. */
  fontsDir: string
  /** yt-dlp (Cortes por link). */
  ytdlp: string | null
}

/** Raiz do projeto em desenvolvimento (pasta com o package.json do MUDO). */
export function findAppRoot(from = process.cwd()): string {
  let dir = path.resolve(from)
  for (;;) {
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        if ((JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name === 'mudo') return dir
      } catch {
        // segue subindo
      }
    }
    const up = path.dirname(dir)
    if (up === dir) return path.resolve(from)
    dir = up
  }
}

/** Função que executa um processo (no job: `ctx.spawn`, que registra e mata junto). */
export type Spawner = (
  command: string,
  args: readonly string[],
  opts?: Omit<SpawnOptions, 'signal' | 'onStart' | 'onExit'>,
) => Promise<SpawnResult>

/**
 * Localiza ffmpeg/ffprobe: variáveis `MUDO_FFMPEG`/`MUDO_FFPROBE`, depois a
 * pasta `binDir` (no app empacotado: `resources/bin`), depois os pacotes
 * `ffmpeg-static`/`ffprobe-static` (desenvolvimento).
 */
export function resolveMediaBinaries(
  opts: { binDir?: string | undefined; modelsDir?: string | undefined; assetsDir?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): MediaBinaries {
  const env = opts.env ?? process.env
  const exe = process.platform === 'win32' ? '.exe' : ''
  const appRoot = opts.binDir && opts.modelsDir && opts.assetsDir ? '' : findAppRoot()
  const binDir = opts.binDir ?? path.join(appRoot, 'resources', 'bin')
  const modelsDir = opts.modelsDir ?? path.join(appRoot, 'resources', 'models')
  const assetsDir = opts.assetsDir ?? path.join(appRoot, 'assets')
  const whisper = env.MUDO_WHISPER ?? path.join(binDir, `whisper-cli${exe}`)
  const whisperModel = path.join(modelsDir, 'ggerganov', 'whisper.cpp', 'ggml-base.bin')
  opts = { ...opts, binDir }
  const pick = (envKey: string, name: string, fallback: () => string): string => {
    const fromEnv = env[envKey]
    if (fromEnv) return fromEnv
    if (opts.binDir) {
      const p = path.join(opts.binDir, `${name}${exe}`)
      if (fs.existsSync(p)) return p
    }
    return fallback()
  }
  return {
    ffmpeg: pick('MUDO_FFMPEG', 'ffmpeg', () => {
      if (!ffmpegStatic) throw new Error('ffmpeg não encontrado para esta plataforma')
      return ffmpegStatic
    }),
    ffprobe: pick('MUDO_FFPROBE', 'ffprobe', () => ffprobeStatic.path),
    whisper: fs.existsSync(whisper) ? whisper : null,
    whisperModel: fs.existsSync(whisperModel) ? whisperModel : null,
    fontsDir: path.join(assetsDir, 'fonts'),
    ytdlp: fs.existsSync(path.join(binDir, `yt-dlp${exe}`)) ? path.join(binDir, `yt-dlp${exe}`) : null,
  }
}

/** Lê `time=HH:MM:SS.xx` de uma linha de progresso do ffmpeg. */
export function parseFfmpegTimeS(line: string): number | null {
  const m = /time=(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line)
  if (!m) return null
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(s) && s >= 0 ? s : null
}

/**
 * Roda o ffmpeg com progresso real lido do `time=` do stderr (seção 8.6).
 * Falha vira `FFMPEG_FAILED` com o final do stderr para diagnóstico.
 */
export async function runFfmpeg(
  spawn: Spawner,
  bin: MediaBinaries,
  args: readonly string[],
  opts: { expectedS?: number; onProgress?: (fraction: number) => void; what: string; cwd?: string },
): Promise<void> {
  const r = await spawn(bin.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    onStderrLine: (line) => {
      if (!opts.onProgress || !opts.expectedS) return
      const t = parseFfmpegTimeS(line)
      if (t !== null) opts.onProgress(Math.min(1, t / opts.expectedS))
    },
  })
  if (r.code !== 0) {
    const why = r.code === null ? `encerrado por sinal ${r.signal ?? ''}`.trim() : `código ${r.code}`
    const lastLine = r.stderrTail.trim().split(/\r?\n/).pop() ?? ''
    throw new JobError('FFMPEG_FAILED', `ffmpeg falhou ao ${opts.what} (${why}): ${lastLine.slice(0, 200)}`, false, {
      stderr: r.stderrTail.slice(-1500),
    })
  }
  opts.onProgress?.(1)
}

const probeSchema = z.object({
  format: z.object({ duration: z.string().optional(), tags: z.record(z.string(), z.string()).optional() }),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        r_frame_rate: z.string().optional(),
        sample_rate: z.string().optional(),
        bit_rate: z.string().optional(),
      }),
    )
    .default([]),
})
export type ProbeResult = z.infer<typeof probeSchema>

export async function probe(spawn: Spawner, bin: MediaBinaries, file: string): Promise<ProbeResult> {
  let out = ''
  const r = await spawn(bin.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    onStdoutLine: (l) => {
      out += `${l}\n`
    },
  })
  if (r.code !== 0) throw new JobError('FFMPEG_FAILED', `ffprobe falhou ao ler ${path.basename(file)}.`, false, { stderr: r.stderrTail })
  return probeSchema.parse(JSON.parse(out))
}

export async function probeDurationS(spawn: Spawner, bin: MediaBinaries, file: string): Promise<number> {
  const p = await probe(spawn, bin, file)
  const d = Number(p.format.duration)
  if (!Number.isFinite(d) || d <= 0) throw new JobError('FFMPEG_FAILED', `duração inválida em ${path.basename(file)}.`)
  return d
}

/** Linha de arquivo para o demuxer `concat` (aspas simples escapadas). */
export function concatListLine(file: string): string {
  return `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
}
