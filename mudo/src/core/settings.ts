import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { DbHandle } from './db'
import { settings } from './db/schema'

/** Lê uma configuração validada; valor ausente ou inválido → padrão. */
export function getSetting<T>(h: DbHandle, key: string, schema: z.ZodType<T>, fallback: T): T {
  const row = h.db.select().from(settings).where(eq(settings.key, key)).get()
  if (!row) return fallback
  const parsed = schema.safeParse(row.value)
  return parsed.success ? parsed.data : fallback
}

export function setSetting(h: DbHandle, key: string, value: unknown): void {
  h.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run()
}

export const SETTING_KEYS = {
  concurrency: 'runner.concurrency',
} as const
