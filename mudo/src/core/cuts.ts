import { desc, eq, inArray } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JOB_STATES, type JobState } from '../shared/enums'
import type { DbHandle } from './db'
import { cutHighlights, cuts, jobs } from './db/schema'
import type { WordTime } from './media/align'
import { jobWorkDir, type DataPaths } from './paths'
import { assertQuota } from './quota'
import { JobError, jobErrorSchema } from './queue/errors'
import { JobQueue, type JobRow } from './queue/queue'

export type CutRow = typeof cuts.$inferSelect
export type HighlightRow = typeof cutHighlights.$inferSelect

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi)$/i

export const cutRequestSchema = z.object({
  source: z.string().trim().min(1).max(2000),
  /** Checkbox obrigatório: "este vídeo é meu ou tenho autorização" (seção 11.3). */
  authorized: z.boolean(),
})

/** Cria o corte e enfileira a análise. Sem a confirmação de autorização, nada acontece. */
export function createCutJob(h: DbHandle, input: z.input<typeof cutRequestSchema>): { cut: CutRow; job: JobRow } {
  const r = cutRequestSchema.safeParse(input)
  if (!r.success) throw new JobError('INVALID_INPUT', 'informe um link ou arquivo de vídeo')
  if (r.data.authorized !== true) {
    throw new JobError('INVALID_INPUT', 'Confirme que o vídeo é seu ou que você tem autorização para usá-lo.')
  }
  const src = r.data.source
  let sourceType: 'file' | 'url'
  if (/^https?:\/\//i.test(src)) {
    sourceType = 'url'
    try {
      new URL(src)
    } catch {
      throw new JobError('INVALID_INPUT', 'link inválido')
    }
  } else {
    sourceType = 'file'
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new JobError('INVALID_INPUT', `arquivo não encontrado: ${src}`)
    if (!VIDEO_EXT.test(src)) throw new JobError('INVALID_INPUT', 'formato de vídeo não suportado (use MP4, MOV, MKV, WebM ou AVI)')
  }
  return h.sqlite.transaction(() => {
    const now = Date.now()
    const cut = h.db
      .insert(cuts)
      .values({
        id: randomUUID(),
        sourceType,
        source: sourceType === 'file' ? path.resolve(src) : src,
        authorizedAt: now,
        title: sourceType === 'file' ? path.parse(src).name : null,
        createdAt: now,
      })
      .returning()
      .get()
    const job = new JobQueue(h).enqueue({ kind: 'cut', payload: { cutId: cut.id } })
    return { cut, job }
  })()
}

export interface CutView {
  id: string
  title: string | null
  source: string
  sourceType: 'file' | 'url'
  durationS: number | null
  state: JobState
  stage: string | null
  progress: number
  error: { code: string; message: string } | null
  highlights: number
  exporting: number
  createdAt: number
}

function jobsFor(h: DbHandle, kind: 'cut' | 'cut_export'): JobRow[] {
  return h.db.select().from(jobs).where(eq(jobs.kind, kind)).orderBy(desc(jobs.createdAt)).all()
}

const cutIdOf = (j: JobRow) => (j.payload as { cutId?: string }).cutId

export function listCutViews(h: DbHandle): CutView[] {
  const rows = h.db.select().from(cuts).orderBy(desc(cuts.createdAt)).all()
  if (rows.length === 0) return []
  const analysis = new Map(jobsFor(h, 'cut').map((j) => [cutIdOf(j), j]))
  const exportsRunning = jobsFor(h, 'cut_export').filter((j) => j.state === 'queued' || j.state === 'running')
  const counts = new Map<string, number>()
  for (const hl of h.db.select().from(cutHighlights).where(inArray(cutHighlights.cutId, rows.map((r) => r.id))).all()) counts.set(hl.cutId, (counts.get(hl.cutId) ?? 0) + 1)
  return rows.map((c) => {
    const j = analysis.get(c.id)
    const e = jobErrorSchema.safeParse(j?.lastError)
    return {
      id: c.id,
      title: c.title,
      source: c.source,
      sourceType: c.sourceType,
      durationS: c.durationS,
      state: z.enum(JOB_STATES).catch('queued').parse(j?.state ?? 'queued'),
      stage: j?.stage ?? null,
      progress: j?.progress ?? 0,
      error: e.success ? { code: e.data.code, message: e.data.message } : null,
      highlights: counts.get(c.id) ?? 0,
      exporting: exportsRunning.filter((x) => cutIdOf(x) === c.id).length,
      createdAt: c.createdAt,
    }
  })
}

export interface CutDetail {
  cut: CutView
  transcript: WordTime[]
  highlights: Array<{
    id: string
    startMs: number
    endMs: number
    score: number
    title: string
    reason: string
    exportedPath: string | null
    exportState: JobState | null
    exportError: string | null
  }>
}

export function getCutDetail(h: DbHandle, cutId: string): CutDetail {
  const view = listCutViews(h).find((c) => c.id === cutId)
  const row = h.db.select().from(cuts).where(eq(cuts.id, cutId)).get()
  if (!view || !row) throw new JobError('INVALID_INPUT', 'corte não encontrado')
  let transcript: WordTime[] = []
  if (row.transcriptPath && fs.existsSync(row.transcriptPath)) transcript = (JSON.parse(fs.readFileSync(row.transcriptPath, 'utf8')) as { words: WordTime[] }).words
  const exportJobs = jobsFor(h, 'cut_export').filter((j) => cutIdOf(j) === cutId)
  const hls = h.db.select().from(cutHighlights).where(eq(cutHighlights.cutId, cutId)).all().sort((a, b) => b.score - a.score)
  return {
    cut: view,
    transcript,
    highlights: hls.map((x) => {
      const j = exportJobs.find((e) => (e.payload as { highlightId?: string }).highlightId === x.id)
      const err = jobErrorSchema.safeParse(j?.lastError)
      return {
        id: x.id,
        startMs: x.startMs,
        endMs: x.endMs,
        score: x.score,
        title: x.title,
        reason: x.reason,
        exportedPath: x.exportedPath && fs.existsSync(x.exportedPath) ? x.exportedPath : null,
        exportState: j ? z.enum(JOB_STATES).catch('queued').parse(j.state) : null,
        exportError: err.success ? err.data.message : null,
      }
    }),
  }
}

/** Exportar 9:16: checa a cota de cortes antes de enfileirar (seção 12). */
export function enqueueCutExport(h: DbHandle, highlightId: string): JobRow {
  const hl = h.db.select().from(cutHighlights).where(eq(cutHighlights.id, highlightId)).get()
  if (!hl) throw new JobError('INVALID_INPUT', 'trecho não encontrado')
  const running = jobsFor(h, 'cut_export').find((j) => (j.payload as { highlightId?: string }).highlightId === highlightId && ['queued', 'running'].includes(j.state))
  if (running) return running
  return h.sqlite.transaction(() => {
    assertQuota(h, 'cut')
    return new JobQueue(h).enqueue({ kind: 'cut_export', payload: { cutId: hl.cutId, highlightId } })
  })()
}

export function deleteCut(h: DbHandle, paths: DataPaths, cutId: string): void {
  const all = [...jobsFor(h, 'cut'), ...jobsFor(h, 'cut_export')].filter((j) => cutIdOf(j) === cutId)
  if (all.some((j) => j.state === 'running')) throw new JobError('INVALID_INPUT', 'Cancele a análise ou a exportação em andamento antes de apagar.')
  h.sqlite.transaction(() => {
    for (const j of all) h.db.delete(jobs).where(eq(jobs.id, j.id)).run()
    h.db.delete(cuts).where(eq(cuts.id, cutId)).run()
  })()
  fs.rmSync(jobWorkDir(paths, cutId).dir, { recursive: true, force: true })
}

export function cutJobOf(h: DbHandle, cutId: string): JobRow | undefined {
  return jobsFor(h, 'cut').find((j) => cutIdOf(j) === cutId)
}
