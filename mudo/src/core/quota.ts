import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { DEFAULT_PLAN, PLAN_IDS, planById, type Plan } from '../shared/plans'
import type { DbHandle } from './db'
import { jobs, usage, videos } from './db/schema'
import { JobError } from './queue/errors'
import { getSetting, setSetting } from './settings'

export const PLAN_SETTING = 'plan.id'

/** Mês corrente no fuso local (reset no dia 1, seção 12). */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthStartMs(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

export function currentPlan(h: DbHandle): Plan {
  return planById(getSetting(h, PLAN_SETTING, z.enum(PLAN_IDS), DEFAULT_PLAN))
}

export function setPlan(h: DbHandle, id: string): Plan {
  const p = z.enum(PLAN_IDS).safeParse(id)
  if (!p.success) throw new JobError('INVALID_INPUT', `plano desconhecido: ${id}`)
  setSetting(h, PLAN_SETTING, p.data)
  return planById(p.data)
}

export interface QuotaStatus {
  plan: Plan
  month: string
  videosUsed: number
  /** Vídeos deste mês ainda em produção (contam para não estourar). */
  videosPending: number
  videosLimit: number | null
  videosRemaining: number | null
  cutsUsed: number
  cutsLimit: number | null
  cutsRemaining: number | null
}

export function quotaStatus(h: DbHandle, now = new Date()): QuotaStatus {
  const plan = currentPlan(h)
  const month = monthKey(now)
  const row = h.db.select().from(usage).where(eq(usage.month, month)).get()
  const pending = h.db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .innerJoin(videos, eq(videos.id, jobs.videoId))
    .where(and(inArray(jobs.state, ['queued', 'running', 'needs_input']), gte(videos.createdAt, monthStartMs(now))))
    .get()
  const videosUsed = row?.videosUsed ?? 0
  const cutsUsed = row?.cutsUsed ?? 0
  const videosPending = pending?.n ?? 0
  const rem = (limit: number | null, used: number) => (limit === null ? null : Math.max(0, limit - used))
  return {
    plan,
    month,
    videosUsed,
    videosPending,
    videosLimit: plan.videosPerMonth,
    videosRemaining: rem(plan.videosPerMonth, videosUsed + videosPending),
    cutsUsed,
    cutsLimit: plan.cutsPerMonth,
    cutsRemaining: rem(plan.cutsPerMonth, cutsUsed),
  }
}

/** Checado ANTES de enfileirar: estouro → QUOTA_EXCEEDED dizendo quanto resta. */
export function assertQuota(h: DbHandle, kind: 'video' | 'cut', now = new Date()): void {
  const q = quotaStatus(h, now)
  const remaining = kind === 'video' ? q.videosRemaining : q.cutsRemaining
  if (remaining !== null && remaining <= 0) {
    const limit = kind === 'video' ? q.videosLimit : q.cutsLimit
    throw new JobError(
      'QUOTA_EXCEEDED',
      `Cota do plano ${q.plan.name} esgotada: ${limit} ${kind === 'video' ? 'vídeos' : 'cortes'} por mês, restam 0${kind === 'video' && q.videosPending > 0 ? ` (${q.videosPending} em produção)` : ''}. A cota renova no dia 1.`,
      false,
      { remaining: 0, limit, month: q.month },
    )
  }
}

/** Consumo confirmado só quando o vídeo chega a `done` (seção 12). */
export function consumeQuota(h: DbHandle, kind: 'video' | 'cut', now = new Date()): void {
  const month = monthKey(now)
  const col = kind === 'video' ? usage.videosUsed : usage.cutsUsed
  h.db
    .insert(usage)
    .values({ month, videosUsed: kind === 'video' ? 1 : 0, cutsUsed: kind === 'cut' ? 1 : 0 })
    .onConflictDoUpdate({ target: usage.month, set: { [kind === 'video' ? 'videosUsed' : 'cutsUsed']: sql`${col} + 1` } })
    .run()
}
