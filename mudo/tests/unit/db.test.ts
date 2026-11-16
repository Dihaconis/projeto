import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataPaths, migrateDatabase, openDatabase, pendingMigrationCount } from '../../src/core'
import { MIGRATIONS_DIR, tempRoot } from '../helpers/env'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('banco e migrações', () => {
  it('cria todas as tabelas e índices, com WAL', () => {
    const root = tempRoot()
    roots.push(root)
    const p = dataPaths(root)
    const h = openDatabase(p.db)
    const r = migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: p.backups })
    expect(r.applied).toBe(1)
    expect(r.backupPath).toBeNull() // banco vazio: nada a salvar

    const names = (h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as {
      name: string
    }[]).map((x) => x.name)
    for (const t of [
      'channels', 'videos', 'jobs', 'job_procs', 'acts', 'scenes', 'images', 'audio_assets',
      'credits', 'settings', 'usage', 'provider_log',
      'jobs_state_idx', 'scenes_video_id_idx', 'images_phash_idx', 'images_last_used_at_idx',
    ]) {
      expect(names).toContain(t)
    }
    expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(pendingMigrationCount(h.sqlite, MIGRATIONS_DIR)).toBe(0)
    expect(migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: p.backups }).applied).toBe(0)
    h.close()
  })

  it('faz backup do .db antes de aplicar migração nova', () => {
    const root = tempRoot()
    roots.push(root)
    const p = dataPaths(root)
    const h = openDatabase(p.db)
    migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: p.backups })
    h.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('marcador', '\"antes\"')").run()

    // migrações = reais + uma nova
    const mig = path.join(root, 'migrations')
    fs.cpSync(MIGRATIONS_DIR, mig, { recursive: true })
    fs.writeFileSync(path.join(mig, '0001_extra.sql'), 'CREATE TABLE `extra_teste` (`id` integer PRIMARY KEY);')
    const journalFile = path.join(mig, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    journal.entries.push({ idx: 1, version: '6', when: Date.now(), tag: '0001_extra', breakpoints: true })
    fs.writeFileSync(journalFile, JSON.stringify(journal))

    const r = migrateDatabase(h, { migrationsDir: mig, backupDir: p.backups })
    expect(r.applied).toBe(1)
    expect(r.backupPath).not.toBeNull()
    const bk = openDatabase(r.backupPath!)
    expect(bk.sqlite.prepare("SELECT value FROM settings WHERE key='marcador'").get()).toEqual({ value: '"antes"' })
    expect(bk.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='extra_teste'").get()).toBeUndefined()
    bk.close()
    expect(h.sqlite.prepare("SELECT 1 AS x FROM sqlite_master WHERE name='extra_teste'").get()).toEqual({ x: 1 })
    h.close()
  })
})
