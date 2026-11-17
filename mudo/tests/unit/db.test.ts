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
    expect(r.applied).toBeGreaterThanOrEqual(1)
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
    fs.writeFileSync(path.join(mig, '0099_extra.sql'), 'CREATE TABLE `extra_teste` (`id` integer PRIMARY KEY);')
    const journalFile = path.join(mig, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    journal.entries.push({ idx: journal.entries.length, version: '6', when: Date.now(), tag: '0099_extra', breakpoints: true })
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

  it('migração que recria tabelas preserva dados e chaves estrangeiras', () => {
    const root = tempRoot()
    roots.push(root)
    const p = dataPaths(root)
    const only0 = path.join(root, 'mig0')
    fs.cpSync(MIGRATIONS_DIR, only0, { recursive: true })
    const jf = path.join(only0, 'meta', '_journal.json')
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'))
    j.entries = j.entries.slice(0, 1)
    fs.writeFileSync(jf, JSON.stringify(j))

    const h = openDatabase(p.db)
    migrateDatabase(h, { migrationsDir: only0, backupDir: p.backups })
    h.sqlite.exec(`
      INSERT INTO channels (id, name, niche, language) VALUES ('c1', 'Canal', 'nicho', 'pt-BR');
      INSERT INTO videos (id, channel_id, theme, language, target_duration_s, state, cost_cents) VALUES ('v1', 'c1', 'tema', 'pt-BR', 420, 'done', 12);
      INSERT INTO jobs (id, kind, video_id, state, max_attempts, payload, checkpoint, stage_timings, cost_cents) VALUES ('j1', 'video', 'v1', 'done', 3, '{}', '{}', '{}', 12);
      INSERT INTO job_procs (job_id, pid, command, started_at) VALUES ('j1', 1, 'ffmpeg', 0);
    `)
    const r = migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: p.backups })
    expect(r.applied).toBe(j.entries.length === 1 ? JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')).entries.length - 1 : 0)
    expect(r.backupPath).not.toBeNull()
    expect(h.sqlite.prepare('SELECT cost_cents FROM videos').get()).toEqual({ cost_cents: 12 })
    expect(h.sqlite.prepare('SELECT video_id FROM jobs').get()).toEqual({ video_id: 'v1' })
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM job_procs').get()).toEqual({ n: 1 })
    expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    h.sqlite.prepare("UPDATE jobs SET cost_cents = 0.37 WHERE id = 'j1'").run()
    expect(h.sqlite.prepare('SELECT cost_cents FROM jobs').get()).toEqual({ cost_cents: 0.37 })
    h.close()
  })
})
