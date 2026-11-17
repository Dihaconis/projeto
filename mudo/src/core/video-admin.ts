import { desc, eq, inArray } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JOB_STATES, LANGUAGES, STAGES, type JobState, type Language } from '../shared/enums'
import type { DbHandle } from './db'
import { acts, channels, credits, jobProcs, jobs, scenes, videos } from './db/schema'
import { jobWorkDir, writeFileAtomic, type DataPaths } from './paths'
import { reviewSchema } from './prompts/review'
import { actSchema, scriptSchema, scriptWordCount } from './prompts/script'
import { jobErrorSchema, JobError } from './queue/errors'
import { videoCheckpointSchema } from './pipeline/video/state'
import { targetWords, videoPayloadSchema } from './videos'

/** Linha da tela Meus Vídeos/Biblioteca: vídeo + job + canal, já resolvidos. */
export interface VideoView {
  id: string
  jobId: string | null
  channelId: string
  channelName: string
  theme: string
  title: string | null
  language: Language
  state: JobState
  stage: (typeof STAGES)[number] | null
  progress: number
  attempt: number
  error: { code: import('../shared/enums').ErrorCode; message: string } | null
  targetDurationS: number
  durationS: number | null
  costCents: number
  genTimeS: number | null
  hasOutput: boolean
  hasThumb: boolean
  createdAt: number
  finishedAt: number | null
  /** Início da execução atual (para o tempo decorrido). */
  startedAt: number | null
}

export function listVideoViews(h: DbHandle, filter: { onlyDone?: boolean } = {}): VideoView[] {
  const vids = h.db.select().from(videos).orderBy(desc(videos.createdAt)).limit(500).all()
  if (vids.length === 0) return []
  const chans = new Map(h.db.select().from(channels).all().map((c) => [c.id, c]))
  const jobRows = h.db.select().from(jobs).where(inArray(jobs.videoId, vids.map((v) => v.id))).all()
  const jobByVideo = new Map(jobRows.map((j) => [j.videoId!, j]))
  const out: VideoView[] = []
  for (const v of vids) {
    const j = jobByVideo.get(v.id)
    const state = z.enum(JOB_STATES).catch('queued').parse(j?.state ?? v.state)
    if (filter.onlyDone && state !== 'done') continue
    const err = jobErrorSchema.safeParse(j?.lastError)
    out.push({
      id: v.id,
      jobId: j?.id ?? null,
      channelId: v.channelId,
      channelName: chans.get(v.channelId)?.name ?? '—',
      theme: v.theme,
      title: v.title,
      language: z.enum(LANGUAGES).catch('pt-BR').parse(v.language),
      state,
      stage: j?.stage ?? null,
      progress: j?.progress ?? v.progress,
      attempt: j?.attempt ?? 0,
      error: err.success ? { code: err.data.code, message: err.data.message } : null,
      targetDurationS: v.targetDurationS,
      durationS: v.actualDurationS,
      costCents: Math.round((j?.costCents ?? v.costCents) * 100) / 100,
      genTimeS: v.genTimeS,
      hasOutput: !!v.outputPath && fs.existsSync(v.outputPath),
      hasThumb: !!v.thumbPath && fs.existsSync(v.thumbPath),
      createdAt: v.createdAt,
      finishedAt: v.finishedAt,
      startedAt: j?.lockedAt ?? null,
    })
  }
  return out
}

export const editableActsSchema = z.array(actSchema).min(5, 'o roteiro precisa de 5 a 7 atos').max(7, 'o roteiro precisa de 5 a 7 atos')

export interface ScriptForEdit {
  acts: Array<{ n: number; heading: string; text: string }>
  issues: Array<{ kind: string; act: number | null; note: string }>
  targetWords: number
  wordCount: number
  editable: boolean
}

function jobOf(h: DbHandle, videoId: string) {
  return h.db.select().from(jobs).where(eq(jobs.videoId, videoId)).get()
}

/** Roteiro atual + pontos levantados pela revisão (tela de edição em needs_input, seção 8.2). */
export function getScriptForEdit(h: DbHandle, paths: DataPaths, videoId: string): ScriptForEdit {
  const v = h.db.select().from(videos).where(eq(videos.id, videoId)).get()
  if (!v) throw new JobError('INVALID_INPUT', 'vídeo não encontrado')
  const j = jobOf(h, videoId)
  const rows = h.db.select().from(acts).where(eq(acts.videoId, videoId)).all().sort((a, b) => a.n - b.n)
  const reviewFile = path.join(jobWorkDir(paths, videoId).dir, 'review.json')
  let issues: ScriptForEdit['issues'] = []
  if (fs.existsSync(reviewFile)) {
    const r = reviewSchema.pick({ issues: true }).safeParse(JSON.parse(fs.readFileSync(reviewFile, 'utf8')))
    if (r.success) issues = r.data.issues
  }
  const payload = videoPayloadSchema.safeParse(j?.payload)
  return {
    acts: rows.map((a) => ({ n: a.n, heading: a.heading, text: a.text })),
    issues,
    targetWords: targetWords(v.targetDurationS, payload.success ? payload.data.wpm : 150),
    wordCount: scriptWordCount(rows),
    editable: !!j && ['needs_input', 'failed', 'cancelled'].includes(j.state) && rows.length >= 5,
  }
}

/**
 * Salva o roteiro editado pelo usuário e invalida tudo o que dependia dele
 * (cenas, narração, segmentos, áudio). A revisão passa a valer como humana.
 * Só com o job parado (aguardando você, falho ou cancelado).
 */
export function saveEditedScript(h: DbHandle, paths: DataPaths, videoId: string, input: unknown): ScriptForEdit {
  const parsed = editableActsSchema.safeParse(input)
  if (!parsed.success) throw new JobError('INVALID_INPUT', parsed.error.issues[0]?.message ?? 'roteiro inválido')
  const list = parsed.data.map((a, i) => ({ ...a, n: i + 1 }))
  const j = jobOf(h, videoId)
  if (!j || !['needs_input', 'failed', 'cancelled'].includes(j.state)) {
    throw new JobError('INVALID_INPUT', 'Só é possível editar o roteiro com a geração parada (aguardando você, falha ou cancelado).')
  }
  const { dir } = jobWorkDir(paths, videoId)
  const scriptFile = path.join(dir, 'script.json')
  if (fs.existsSync(scriptFile)) {
    const s = scriptSchema.safeParse(JSON.parse(fs.readFileSync(scriptFile, 'utf8')))
    if (s.success) writeFileAtomic(scriptFile, JSON.stringify({ ...s.data, acts: list }, null, 2))
  }
  const cp = videoCheckpointSchema.safeParse(j.checkpoint)
  const kept = cp.success ? cp.data : videoCheckpointSchema.parse({})
  const nextCp = {
    script: kept.script,
    review: { status: 'human' as const, rounds: kept.review?.rounds ?? 0, issues: kept.review?.issues ?? [] },
    segments: {},
  }
  h.sqlite.transaction(() => {
    h.db.delete(scenes).where(eq(scenes.videoId, videoId)).run()
    h.db.delete(credits).where(eq(credits.videoId, videoId)).run()
    h.db.delete(acts).where(eq(acts.videoId, videoId)).run()
    for (const a of list) h.db.insert(acts).values({ id: randomUUID(), videoId, n: a.n, heading: a.heading, text: a.text }).run()
    h.db.update(jobs).set({ checkpoint: nextCp, updatedAt: Date.now() }).where(eq(jobs.id, j.id)).run()
    h.db.update(videos).set({ actualDurationS: null, outputPath: null, thumbPath: null }).where(eq(videos.id, videoId)).run()
  })()
  for (const sub of ['tts', 'segments', 'tmp']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true })
  for (const f of ['narration.wav', 'audio.wav']) fs.rmSync(path.join(dir, f), { force: true })
  return getScriptForEdit(h, paths, videoId)
}

/** Apaga o vídeo: arquivos de saída, pasta de trabalho e registros. Nunca com a geração rodando. */
export function deleteVideo(h: DbHandle, paths: DataPaths, videoId: string): void {
  const v = h.db.select().from(videos).where(eq(videos.id, videoId)).get()
  if (!v) throw new JobError('INVALID_INPUT', 'vídeo não encontrado')
  const j = jobOf(h, videoId)
  if (j?.state === 'running') throw new JobError('INVALID_INPUT', 'Cancele a geração antes de apagar o vídeo.')
  const files: string[] = []
  if (v.outputPath) files.push(v.outputPath, v.outputPath.replace(/\.mp4$/i, '.txt'))
  if (v.thumbPath) files.push(v.thumbPath, v.thumbPath.replace('thumbnail 1', 'thumbnail 2'))
  h.sqlite.transaction(() => {
    if (j) {
      h.db.delete(jobProcs).where(eq(jobProcs.jobId, j.id)).run()
      h.db.delete(jobs).where(eq(jobs.id, j.id)).run()
    }
    h.db.delete(videos).where(eq(videos.id, videoId)).run() // cenas, atos e créditos em cascata
  })()
  for (const f of files) fs.rmSync(f, { force: true })
  fs.rmSync(jobWorkDir(paths, videoId).dir, { recursive: true, force: true })
}

/** Caminho de mídia servido ao renderer pelo protocolo `mudo-media` (só leitura). */
export function videoMediaPath(h: DbHandle, videoId: string, kind: 'video' | 'thumb' | 'thumb2'): string | null {
  const v = h.db.select().from(videos).where(eq(videos.id, videoId)).get()
  if (!v) return null
  const p = kind === 'video' ? v.outputPath : kind === 'thumb' ? v.thumbPath : v.thumbPath?.replace('thumbnail 1', 'thumbnail 2')
  return p && fs.existsSync(p) ? p : null
}
