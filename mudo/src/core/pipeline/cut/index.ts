import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AI_DISCLOSURE_METADATA } from '../../../shared/enums'
import { cutHighlights, cuts } from '../../db/schema'
import type { WordTime } from '../../media/align'
import { probeDurationS, runFfmpeg } from '../../media/ffmpeg'
import { buildAss, DEFAULT_SUB_STYLE } from '../../media/subtitles'
import { writeFileAtomic } from '../../paths'
import { buildCutsPrompt, CUT_MAX_S, CUT_MIN_S, highlightsJsonSchema, highlightsSchema, type TranscriptSentence } from '../../prompts/cuts'
import { callWithFallback } from '../../providers/call'
import { stripJsonFences } from '../../providers/types'
import { consumeQuota } from '../../quota'
import { JobError } from '../../queue/errors'
import { getSetting } from '../../settings'
import { defaultOutputDir, OUTPUT_DIR_SETTING } from '../video/assemble-stage'
import type { JobContext, JobHandler } from '../context'

const MAX_SOURCE_S = 3 * 3600

const payloadSchema = z.object({ cutId: z.uuid() })
const exportPayloadSchema = z.object({ cutId: z.uuid(), highlightId: z.uuid() })
const checkpointSchema = z.object({ quotaConsumed: z.literal(true).optional() })

function loadCut(ctx: JobContext, cutId: string) {
  const c = ctx.db.db.select().from(cuts).where(eq(cuts.id, cutId)).get()
  if (!c) throw new JobError('INVALID_INPUT', 'corte não encontrado')
  return c
}
const updateCut = (ctx: JobContext, id: string, patch: Partial<typeof cuts.$inferInsert>) => ctx.db.db.update(cuts).set(patch).where(eq(cuts.id, id)).run()

/** Agrupa palavras em frases (pontuação ou pausa > 0,7 s; no máximo ~25 s). */
export function sentencesFromWords(words: WordTime[]): TranscriptSentence[] {
  const out: TranscriptSentence[] = []
  let cur: WordTime[] = []
  const flush = () => {
    if (cur.length) out.push({ startMs: cur[0]!.startMs, endMs: cur.at(-1)!.endMs, text: cur.map((w) => w.word).join(' ') })
    cur = []
  }
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (cur.length && prev && (w.startMs - prev.endMs > 700 || w.endMs - cur[0]!.startMs > 25_000)) flush()
    cur.push(w)
    if (/[.!?…]$/u.test(w.word)) flush()
  })
  flush()
  return out
}

const whisperFullSchema = z.object({
  result: z.object({ language: z.string() }).optional(),
  transcription: z.array(z.object({ offsets: z.object({ from: z.number(), to: z.number() }), text: z.string() })),
})

/** Análise (seção 11.3): baixa/abre → transcreve (whisper.cpp) → aponta trechos com nota e justificativa. */
export const cutHandler: JobHandler = async (ctx) => {
  const { cutId } = payloadSchema.parse(ctx.job.payload)
  let cut = loadCut(ctx, cutId)

  // ---- 1) mídia ----
  ctx.enterStage('download')
  if (!cut.mediaPath || !fs.existsSync(cut.mediaPath)) {
    let media = cut.source
    if (cut.sourceType === 'url') {
      if (!ctx.media.ytdlp) throw new JobError('INTERNAL', 'yt-dlp não está instalado (resources/bin)')
      fs.mkdirSync(ctx.workDir, { recursive: true })
      let title: string | null = null
      let file: string | null = null
      const r = await ctx.spawn(
        ctx.media.ytdlp,
        [
          '--no-playlist', '--newline', '--no-colors', '--encoding', 'utf-8',
          '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
          '--merge-output-format', 'mp4',
          '--ffmpeg-location', path.dirname(ctx.media.ffmpeg),
          '-o', path.join(ctx.workDir, 'source.%(ext)s'),
          '--print', 'before_dl:MUDO_TITLE:%(title)s',
          '--print', 'after_move:MUDO_FILE:%(filepath)s',
          cut.source,
        ],
        {
          // no Windows o Python escreve na página de código do console e estraga acentos do caminho
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          onStdoutLine: (l) => {
            const pct = /\[download\]\s+([\d.]+)%/.exec(l)
            if (pct) ctx.stageProgress(Number(pct[1]) / 100)
            if (l.startsWith('MUDO_TITLE:')) title = l.slice(11).trim()
            if (l.startsWith('MUDO_FILE:')) file = l.slice(10).trim()
          },
        },
      )
      if (r.code === 0 && (!file || !fs.existsSync(file))) {
        // o caminho impresso pode vir com outra codificação; o nome do arquivo é nosso (source.<ext>)
        const found = fs.readdirSync(ctx.workDir).find((n) => /^source\.(mp4|mkv|webm|mov|m4v)$/i.test(n))
        if (found) file = path.join(ctx.workDir, found)
      }
      if (r.code !== 0 || !file || !fs.existsSync(file)) {
        throw new JobError('INVALID_INPUT', `Não foi possível baixar o vídeo do link (yt-dlp código ${r.code}). Confira o link ou use um arquivo local.`, false, {
          stderr: r.stderrTail.slice(-800),
        })
      }
      media = file
      if (title) updateCut(ctx, cutId, { title })
    }
    const durationS = await probeDurationS(ctx.spawn, ctx.media, media)
    if (durationS > MAX_SOURCE_S) throw new JobError('INVALID_INPUT', 'O vídeo tem mais de 3 horas; corte-o antes de analisar.')
    updateCut(ctx, cutId, { mediaPath: media, durationS })
    cut = loadCut(ctx, cutId)
  }
  ctx.stageProgress(1)

  // ---- 2) transcrição ----
  ctx.enterStage('transcribe')
  const transcriptFile = path.join(ctx.workDir, 'transcript.json')
  if (!cut.transcriptPath || !fs.existsSync(cut.transcriptPath)) {
    if (!ctx.media.whisper || !ctx.media.whisperModel) throw new JobError('INTERNAL', 'whisper.cpp não encontrado (resources/bin e resources/models)')
    fs.mkdirSync(ctx.tmpDir, { recursive: true })
    const wav = path.join(ctx.tmpDir, 'audio16k.wav')
    await runFfmpeg(ctx.spawn, ctx.media, ['-i', cut.mediaPath!, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
      what: 'extrair o áudio',
      expectedS: cut.durationS ?? undefined,
      onProgress: (f) => ctx.stageProgress(f * 0.1),
    })
    const base = path.join(ctx.tmpDir, 'whisper')
    const r = await ctx.spawn(ctx.media.whisper, ['-m', ctx.media.whisperModel, '-f', wav, '-l', 'auto', '-ml', '1', '-sow', '-oj', '-of', base, '-pp', '-t', '4'], {
      onStderrLine: (l) => {
        const m = /progress\s*=\s*(\d+)%/.exec(l)
        if (m) ctx.stageProgress(0.1 + (Number(m[1]) / 100) * 0.9)
      },
    })
    if (r.code !== 0 || !fs.existsSync(`${base}.json`)) {
      throw new JobError('INTERNAL', `a transcrição falhou (whisper.cpp código ${r.code})`, true, { stderr: r.stderrTail.slice(-800) })
    }
    const j = whisperFullSchema.parse(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')))
    const words: WordTime[] = j.transcription
      .map((t) => ({ word: t.text.trim(), startMs: t.offsets.from, endMs: t.offsets.to }))
      .filter((w) => w.word && !/^\[.*\]$/.test(w.word))
    writeFileAtomic(transcriptFile, JSON.stringify({ language: j.result?.language ?? null, words }))
    updateCut(ctx, cutId, { transcriptPath: transcriptFile, language: j.result?.language ?? null })
    fs.rmSync(wav, { force: true })
    cut = loadCut(ctx, cutId)
  }
  ctx.stageProgress(1)

  // ---- 3) análise ----
  ctx.enterStage('analyze')
  const existing = ctx.db.db.select().from(cutHighlights).where(eq(cutHighlights.cutId, cutId)).all()
  if (existing.length === 0) {
    const { words } = JSON.parse(fs.readFileSync(cut.transcriptPath!, 'utf8')) as { words: WordTime[] }
    const sentences = sentencesFromWords(words)
    if (sentences.length === 0) throw new JobError('INVALID_INPUT', 'Não há fala reconhecível neste vídeo para sugerir cortes.')
    const durationS = cut.durationS ?? sentences.at(-1)!.endMs / 1000
    const { system, prompt } = buildCutsPrompt(sentences, durationS)
    const r = await callWithFallback(await ctx.providers.llm(), () => ({ system, prompt, jsonSchema: highlightsJsonSchema as unknown as Record<string, unknown>, expectedOutputTokens: 900 }), {
      db: ctx.db,
      log: ctx.log,
      signal: ctx.signal,
      stage: 'analyze',
      videoId: null,
    })
    ctx.addCost(r.output.costCents)
    const parsed = highlightsSchema.safeParse(JSON.parse(stripJsonFences(r.output.text)))
    if (!parsed.success) throw new JobError('SCRIPT_SCHEMA', 'A análise devolveu trechos em formato inválido.', true)
    // encaixa nas frases, respeita 15–90 s, sem sobreposição
    const snap = (ms: number, edge: 'start' | 'end') =>
      sentences.reduce((best, s) => (Math.abs((edge === 'start' ? s.startMs : s.endMs) - ms) < Math.abs(best - ms) ? (edge === 'start' ? s.startMs : s.endMs) : best), edge === 'start' ? sentences[0]!.startMs : sentences.at(-1)!.endMs)
    const accepted: Array<{ startMs: number; endMs: number; score: number; title: string; reason: string }> = []
    for (const hl of parsed.data.highlights.sort((a, b) => b.score - a.score)) {
      const startMs = snap(hl.start_s * 1000, 'start')
      const endMs = snap(hl.end_s * 1000, 'end')
      const d = (endMs - startMs) / 1000
      if (d < CUT_MIN_S || d > CUT_MAX_S) continue
      if (accepted.some((a) => startMs < a.endMs && endMs > a.startMs)) continue
      accepted.push({ startMs, endMs, score: hl.score, title: hl.title, reason: hl.reason })
    }
    if (accepted.length === 0) throw new JobError('INVALID_INPUT', 'Nenhum trecho de 15 a 90 s se sustenta sozinho neste vídeo.')
    ctx.db.sqlite.transaction(() => {
      for (const a of accepted) ctx.db.db.insert(cutHighlights).values({ id: randomUUID(), cutId, ...a }).run()
    })()
  }
  ctx.stageProgress(1)
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
}

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 50)
      .trim() || 'corte'
  )
}

/** Exporta um trecho em 9:16 (1080×1920) com legenda queimada e loudnorm. */
export const cutExportHandler: JobHandler = async (ctx) => {
  const { cutId, highlightId } = exportPayloadSchema.parse(ctx.job.payload)
  const cut = loadCut(ctx, cutId)
  const hl = ctx.db.db.select().from(cutHighlights).where(eq(cutHighlights.id, highlightId)).get()
  if (!hl) throw new JobError('INVALID_INPUT', 'trecho não encontrado')
  if (!cut.mediaPath || !fs.existsSync(cut.mediaPath)) throw new JobError('INVALID_INPUT', 'o vídeo de origem não está mais disponível; analise de novo')
  ctx.enterStage('export')
  const cp = checkpointSchema.parse(ctx.checkpoint<unknown>() ?? {})

  if (!hl.exportedPath || !fs.existsSync(hl.exportedPath)) {
    const words = cut.transcriptPath ? (JSON.parse(fs.readFileSync(cut.transcriptPath, 'utf8')) as { words: WordTime[] }).words : []
    const inside = words.filter((w) => w.startMs >= hl.startMs - 50 && w.endMs <= hl.endMs + 50)
    fs.mkdirSync(ctx.tmpDir, { recursive: true })
    const fontsLocal = path.join(ctx.tmpDir, 'fonts')
    fs.mkdirSync(fontsLocal, { recursive: true })
    for (const f of fs.readdirSync(ctx.media.fontsDir)) if (f.endsWith('.ttf')) fs.copyFileSync(path.join(ctx.media.fontsDir, f), path.join(fontsLocal, f))
    const assName = `cut-${hl.id.slice(0, 8)}.ass`
    const style = { ...DEFAULT_SUB_STYLE, fontSize: 78, outline: 7, marginV: 420 }
    fs.writeFileSync(path.join(ctx.tmpDir, assName), buildAss(inside, hl.startMs, hl.endMs, style, { width: 1080, height: 1920, maxLineChars: 20 }))

    const outDir = path.join(getSetting(ctx.db, OUTPUT_DIR_SETTING, z.string().min(1), defaultOutputDir()), 'Cortes')
    fs.mkdirSync(outDir, { recursive: true })
    let base = `${slug(cut.title ?? 'video')} - ${slug(hl.title)}`
    for (let i = 2; fs.existsSync(path.join(outDir, `${base}.mp4`)); i++) base = `${slug(cut.title ?? 'video')} - ${slug(hl.title)} (${i})`
    const tmpOut = `tmp-${hl.id.slice(0, 8)}.mp4`
    const durS = (hl.endMs - hl.startMs) / 1000
    await runFfmpeg(
      ctx.spawn,
      ctx.media,
      [
        '-ss', (hl.startMs / 1000).toFixed(3), '-t', durS.toFixed(3), '-i', cut.mediaPath,
        '-filter_complex',
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,subtitles=${assName}:fontsdir=fonts,format=yuv420p[v];` +
          `[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
        '-map', '[v]', '-map', '[a]',
        '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-movflags', '+faststart',
        '-metadata', `title=${hl.title}`,
        '-metadata', `comment=${AI_DISCLOSURE_METADATA}`,
        tmpOut,
      ],
      { what: 'exportar o corte 9:16', expectedS: durS, cwd: ctx.tmpDir, onProgress: (f) => ctx.stageProgress(f) },
    )
    const out = path.join(outDir, `${base}.mp4`)
    fs.copyFileSync(path.join(ctx.tmpDir, tmpOut), out)
    ctx.db.db.update(cutHighlights).set({ exportedPath: out, exportedAt: Date.now() }).where(eq(cutHighlights.id, hl.id)).run()
  }
  // cota de cortes: só quando o corte fica pronto, uma vez por exportação
  if (!cp.quotaConsumed) {
    ctx.saveCheckpoint({ ...cp, quotaConsumed: true })
    consumeQuota(ctx.db, 'cut')
  }
  ctx.stageProgress(1)
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
}
