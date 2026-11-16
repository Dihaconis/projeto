import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

export interface DbHandle {
  sqlite: Database.Database
  db: Db
  close(): void
}

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() })),
})

/** Abre o banco com WAL e espera em lock (vários processos: app, runner, CLI). */
export function openDatabase(file: string): DbHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  return { sqlite, db, close: () => sqlite.close() }
}

export function pendingMigrationCount(sqlite: Database.Database, migrationsDir: string): number {
  const journalPath = path.join(migrationsDir, 'meta', '_journal.json')
  const journal = journalSchema.parse(JSON.parse(fs.readFileSync(journalPath, 'utf8')))
  const hasTable = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get()
  if (!hasTable) return journal.entries.length
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
  return Math.max(0, journal.entries.length - row.n)
}

export interface MigrateResult {
  applied: number
  backupPath: string | null
}

/**
 * Aplica migrações pendentes. Se o banco já tem dados, faz backup consistente
 * (`VACUUM INTO`) antes, em `backupDir`, mantendo os `keepBackups` mais novos.
 */
export function migrateDatabase(
  handle: DbHandle,
  opts: { migrationsDir: string; backupDir: string; keepBackups?: number },
): MigrateResult {
  const pending = pendingMigrationCount(handle.sqlite, opts.migrationsDir)
  if (pending === 0) return { applied: 0, backupPath: null }

  let backupPath: string | null = null
  const userTables = handle.sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number }
  if (userTables.n > 0) {
    fs.mkdirSync(opts.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = path.join(opts.backupDir, `mudo-${stamp}.db`)
    handle.sqlite.prepare('VACUUM INTO ?').run(backupPath)
    pruneBackups(opts.backupDir, opts.keepBackups ?? 5)
  }

  migrate(handle.db, { migrationsFolder: opts.migrationsDir })
  return { applied: pending, backupPath }
}

function pruneBackups(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('mudo-') && f.endsWith('.db'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true })
  }
}

export { schema }
