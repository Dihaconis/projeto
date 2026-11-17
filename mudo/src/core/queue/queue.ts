import { and, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { DEFAULTS, type AnyStage, type JobKind, type JobState } from '../../shared/enums'
import type { DbHandle } from '../db'
import { jobProcs, jobs } from '../db/schema'
import type { JobErrorInfo } from './errors'

export type JobRow = typeof jobs.$inferSelect
export type StageTimings = Partial<Record<AnyStage, number>>

export type Clock = () => number

export interface EnqueueInput {
  kind: JobKind
  videoId?: string | null
  payload: unknown
  maxAttempts?: number
}

export type FinishOutcome =
  | { state: 'done' }
  | { state: 'failed'; error: JobErrorInfo }
  | { state: 'needs_input'; error: JobErrorInfo }
  /** Devolve à fila. `countAttempt=false` para desligamento limpo do runner. */
  | { state: 'queued'; error?: JobErrorInfo; countAttempt: boolean }

export interface ProgressPatch {
  stage?: AnyStage | null
  progress?: number
  checkpoint?: unknown
  stageTimings?: StageTimings
  costCents?: number
}

/**
 * Fila persistente em SQLite (tabela `jobs`). Toda escrita feita por um runner
 * exige que ele ainda seja o dono (`state = 'running' AND locked_by = runnerId`):
 * se o job foi cancelado ou reaproveitado como órfão, a escrita não acontece e
 * o runner sabe que perdeu o job.
 */
export class JobQueue {
  constructor(
    private readonly h: DbHandle,
    private readonly clock: Clock = Date.now,
  ) {}

  enqueue(input: EnqueueInput): JobRow {
    const t = this.clock()
    const row = this.h.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        kind: input.kind,
        videoId: input.videoId ?? null,
        state: 'queued',
        stage: null,
        progress: 0,
        attempt: 0,
        maxAttempts: input.maxAttempts ?? DEFAULTS.maxAttempts,
        payload: input.payload ?? {},
        checkpoint: {},
        stageTimings: {},
        createdAt: t,
        updatedAt: t,
      })
      .returning()
      .get()
    return row
  }

  get(id: string): JobRow | undefined {
    return this.h.db.select().from(jobs).where(eq(jobs.id, id)).get()
  }

  list(limit = 200): JobRow[] {
    return this.h.db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit).all()
  }

  countByState(state: JobState): number {
    const r = this.h.db
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(eq(jobs.state, state))
      .get()
    return r?.n ?? 0
  }

  /**
   * Reivindica atomicamente o job mais antigo na fila — ou, com `onlyId`,
   * apenas aquele job (CLI `--wait` processa só o que ela mesma criou).
   */
  claim(runnerId: string, onlyId?: string): JobRow | null {
    const t = this.clock()
    const pick = onlyId
      ? `SELECT id FROM jobs WHERE state = 'queued' AND id = @onlyId`
      : `SELECT id FROM jobs WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1`
    const row = this.h.sqlite
      .prepare(
        `UPDATE jobs
            SET state = 'running', locked_by = @runnerId, locked_at = @t, heartbeat_at = @t,
                attempt = attempt + 1, updated_at = @t
          WHERE id = (${pick})
            AND state = 'queued'
        RETURNING id`,
      )
      .get({ runnerId, t, onlyId: onlyId ?? null }) as { id: string } | undefined
    if (!row) return null
    this.syncVideo(row.id)
    return this.get(row.id) ?? null
  }

  /**
   * Espelha estado/etapa/progresso/custo do job no vídeo, para que toda tela
   * leia o mesmo valor (seção 18: nada de dado divergente entre telas).
   */
  private syncVideo(id: string): void {
    this.h.sqlite
      .prepare(
        `UPDATE videos SET state = j.state, stage = j.stage, progress = j.progress, cost_cents = j.cost_cents,
                finished_at = CASE WHEN j.state = 'done' THEN j.finished_at ELSE videos.finished_at END
           FROM (SELECT video_id, state, stage, progress, cost_cents, finished_at FROM jobs WHERE id = ?) AS j
          WHERE videos.id = j.video_id`,
      )
      .run(id)
  }

  private owned(id: string, runnerId: string) {
    return and(eq(jobs.id, id), eq(jobs.state, 'running'), eq(jobs.lockedBy, runnerId))
  }

  /** Renova a posse. `false` = o runner perdeu o job (cancelado/órfão). */
  heartbeat(id: string, runnerId: string): boolean {
    const t = this.clock()
    const r = this.h.db.update(jobs).set({ heartbeatAt: t }).where(this.owned(id, runnerId)).run()
    return r.changes === 1
  }

  update(id: string, runnerId: string, patch: ProgressPatch): boolean {
    const t = this.clock()
    const set: Partial<typeof jobs.$inferInsert> = { updatedAt: t, heartbeatAt: t }
    if (patch.stage !== undefined) set.stage = patch.stage
    if (patch.progress !== undefined) set.progress = Math.min(1, Math.max(0, patch.progress))
    if (patch.checkpoint !== undefined) set.checkpoint = patch.checkpoint
    if (patch.stageTimings !== undefined) set.stageTimings = patch.stageTimings
    if (patch.costCents !== undefined) set.costCents = patch.costCents
    const r = this.h.db.update(jobs).set(set).where(this.owned(id, runnerId)).run()
    if (r.changes === 1 && (patch.stage !== undefined || patch.progress !== undefined || patch.costCents !== undefined)) this.syncVideo(id)
    return r.changes === 1
  }

  finish(id: string, runnerId: string, outcome: FinishOutcome): boolean {
    const t = this.clock()
    const base = { lockedBy: null, lockedAt: null, heartbeatAt: null, updatedAt: t }
    let set: Partial<typeof jobs.$inferInsert>
    switch (outcome.state) {
      case 'done':
        set = { ...base, state: 'done', progress: 1, lastError: null, finishedAt: t }
        break
      case 'failed':
        set = { ...base, state: 'failed', lastError: outcome.error, finishedAt: t }
        break
      case 'needs_input':
        set = { ...base, state: 'needs_input', lastError: outcome.error }
        break
      case 'queued':
        set = { ...base, state: 'queued', lastError: outcome.error ?? null }
        if (!outcome.countAttempt) set.attempt = sql`MAX(0, ${jobs.attempt} - 1)` as unknown as number
        break
    }
    const r = this.h.db.update(jobs).set(set).where(this.owned(id, runnerId)).run()
    if (r.changes === 1) this.syncVideo(id)
    return r.changes === 1
  }

  /**
   * Cancela. Se estiver rodando, o runner percebe no próximo heartbeat (posse
   * perdida), mata a árvore de processos e limpa os temporários.
   */
  cancel(id: string): { ok: boolean; wasRunning: boolean; job?: JobRow } {
    const job = this.get(id)
    if (!job) return { ok: false, wasRunning: false }
    if (job.state === 'done' || job.state === 'cancelled') return { ok: false, wasRunning: false, job }
    const t = this.clock()
    const r = this.h.db
      .update(jobs)
      .set({
        state: 'cancelled',
        lastError: { code: 'CANCELLED', message: 'Cancelado pelo usuário.' },
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: t,
        finishedAt: t,
      })
      .where(and(eq(jobs.id, id), inArray(jobs.state, ['queued', 'running', 'needs_input', 'failed'])))
      .run()
    if (r.changes === 1) this.syncVideo(id)
    return { ok: r.changes === 1, wasRunning: job.state === 'running', job: this.get(id) }
  }

  /** Retomar: volta para a fila a partir do checkpoint, com tentativas zeradas. */
  resume(id: string): { ok: boolean; job?: JobRow } {
    const t = this.clock()
    const r = this.h.db
      .update(jobs)
      .set({ state: 'queued', attempt: 0, lastError: null, finishedAt: null, updatedAt: t })
      .where(and(eq(jobs.id, id), inArray(jobs.state, ['failed', 'cancelled', 'needs_input'])))
      .run()
    if (r.changes === 1) this.syncVideo(id)
    return { ok: r.changes === 1, job: this.get(id) }
  }

  /** Jobs `running` cujo heartbeat é mais velho que `staleMs`. */
  findOrphans(staleMs: number): JobRow[] {
    const limit = this.clock() - staleMs
    return this.h.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.state, 'running'),
          or(lt(jobs.heartbeatAt, limit), sql`${jobs.heartbeatAt} IS NULL`),
        ),
      )
      .all()
  }

  /**
   * Devolve um órfão à fila (ou falha se esgotou tentativas). Só age se o job
   * continua órfão no momento da escrita, para não roubar um job vivo.
   */
  recoverOrphan(id: string, staleMs: number): 'requeued' | 'failed' | 'skipped' {
    const t = this.clock()
    const limit = t - staleMs
    const stillOrphan = and(
      eq(jobs.id, id),
      eq(jobs.state, 'running'),
      or(lt(jobs.heartbeatAt, limit), sql`${jobs.heartbeatAt} IS NULL`),
    )
    return this.h.sqlite.transaction(() => {
      const job = this.h.db.select().from(jobs).where(stillOrphan).get()
      if (!job) return 'skipped' as const
      const base = { lockedBy: null, lockedAt: null, heartbeatAt: null, updatedAt: t }
      if (job.attempt >= job.maxAttempts) {
        this.h.db
          .update(jobs)
          .set({
            ...base,
            state: 'failed',
            finishedAt: t,
            lastError: {
              code: 'ORPHAN_MAX_ATTEMPTS',
              message: `O processo de geração parou ${job.attempt} vez(es) durante este job. Use "Retomar" para tentar de novo a partir do último checkpoint.`,
            },
          })
          .where(eq(jobs.id, id))
          .run()
        this.syncVideo(id)
        return 'failed' as const
      }
      this.h.db.update(jobs).set({ ...base, state: 'queued' }).where(eq(jobs.id, id)).run()
      this.syncVideo(id)
      return 'requeued' as const
    })()
  }

  // ---- processos filhos registrados por job ----

  addProc(jobId: string, pid: number, command: string): void {
    this.h.db
      .insert(jobProcs)
      .values({ jobId, pid, command, startedAt: this.clock() })
      .onConflictDoNothing()
      .run()
  }

  removeProc(jobId: string, pid: number): void {
    this.h.db.delete(jobProcs).where(and(eq(jobProcs.jobId, jobId), eq(jobProcs.pid, pid))).run()
  }

  listProcs(jobId: string) {
    return this.h.db.select().from(jobProcs).where(eq(jobProcs.jobId, jobId)).all()
  }

  clearProcs(jobId: string): void {
    this.h.db.delete(jobProcs).where(eq(jobProcs.jobId, jobId)).run()
  }

  /** Processos registrados de jobs que não estão mais rodando (sobras de crash). */
  strayProcs() {
    return this.h.db
      .select({ jobId: jobProcs.jobId, pid: jobProcs.pid, command: jobProcs.command })
      .from(jobProcs)
      .innerJoin(jobs, eq(jobs.id, jobProcs.jobId))
      .where(and(isNotNull(jobProcs.pid), sql`${jobs.state} <> 'running'`))
      .all()
  }
}
