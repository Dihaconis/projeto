/**
 * Prepara dados para os e2e do app: roda o pipeline real NO PROCESSO DO TESTE
 * com provedores de fixture (o app empacotado nunca tem fixtures) e grava no
 * mesmo banco que o app vai abrir.
 */
import path from 'node:path'
import {
  Runner,
  createChannel,
  createCutJob,
  createVideoJob,
  dataPaths,
  ensureDataDirs,
  jobHandlers,
  migrateDatabase,
  nullLogger,
  openDatabase,
  resolveMediaBinaries,
  setSetting,
} from '../../src/core'
import { MIGRATIONS_DIR, waitFor } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureTts } from '../helpers/fixtures'

export async function seedVideo(root: string, kind: 'done' | 'review-rejected'): Promise<{ videoId: string; jobId: string; outputPath: string }> {
  const paths = dataPaths(root)
  ensureDataDirs(paths)
  const h = openDatabase(paths.db)
  migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: paths.backups })
  setSetting(h, 'output.dir', path.join(root, 'saída'))
  const ch = createChannel(h, { name: 'Canal Ciência', niche: 'ciência', language: 'pt-BR' })
  const { video, job } = createVideoJob(h, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
  const llm = kind === 'done' ? fixtureLlm() : fixtureLlm('llm', undefined, { review: 'llm/review-rejected.json' })
  const r = new Runner({ handle: h, paths, log: nullLogger(), handlers: jobHandlers, providers: fixtureSource([llm], [fixtureTts()]), media: resolveMediaBinaries(), pollMs: 20 })
  r.start()
  await waitFor(() => ['done', 'failed', 'needs_input'].includes(r.queue.get(job.id)!.state), 180_000)
  await r.stop()
  const out = h.sqlite.prepare('SELECT output_path FROM videos WHERE id = ?').get(video.id) as { output_path: string | null }
  h.close()
  return { videoId: video.id, jobId: job.id, outputPath: out.output_path ?? '' }
}

/** Corte já analisado (fixture de LLM) para o app exportar. */
export async function seedCut(root: string, file: string): Promise<{ cutId: string; highlightId: string }> {
  const paths = dataPaths(root)
  ensureDataDirs(paths)
  const h = openDatabase(paths.db)
  migrateDatabase(h, { migrationsDir: MIGRATIONS_DIR, backupDir: paths.backups })
  setSetting(h, 'output.dir', path.join(root, 'saída'))
  const { cut, job } = createCutJob(h, { source: file, authorized: true })
  const r = new Runner({ handle: h, paths, log: nullLogger(), handlers: jobHandlers, providers: fixtureSource([fixtureLlm()], [fixtureTts()]), media: resolveMediaBinaries(), pollMs: 20 })
  r.start()
  await waitFor(() => ['done', 'failed', 'needs_input'].includes(r.queue.get(job.id)!.state), 180_000)
  await r.stop()
  const hl = h.sqlite.prepare('SELECT id FROM cut_highlights WHERE cut_id = ? ORDER BY score DESC').get(cut.id) as { id: string } | undefined
  if (!hl) throw new Error('a análise de fixture não gerou trechos')
  h.close()
  return { cutId: cut.id, highlightId: hl.id }
}
