import { eq, inArray } from 'drizzle-orm'
import path from 'node:path'
import { z } from 'zod'
import type { DbHandle } from './db'
import { audioAssets, images, jobs, scenes, videos } from './db/schema'
import { writeFileAtomic } from './paths'
import { videoCheckpointSchema } from './pipeline/video/state'

/** Uma linha da tela Licenças: imagem ou música usada num vídeo (seção 9). */
export interface LicenseEntry {
  kind: 'image' | 'music'
  assetId: string
  /** Cenas onde a imagem aparece (vazio para música). */
  scenes: number[]
  source: string
  author: string | null
  sourceUrl: string | null
  license: string | null
  requiresCredit: boolean
  creditText: string | null
  /** `ok` = pode ser usado; senão, o motivo do bloqueio. */
  status: 'ok' | 'missing_license' | 'missing_credit'
}

function status(license: string | null, requiresCredit: boolean, credit: string | null): LicenseEntry['status'] {
  if (!license) return 'missing_license'
  if (requiresCredit && !credit?.trim()) return 'missing_credit'
  return 'ok'
}

export function videoLicenses(h: DbHandle, videoId: string): LicenseEntry[] {
  const sceneRows = h.db.select().from(scenes).where(eq(scenes.videoId, videoId)).all().sort((a, b) => a.n - b.n)
  const byImage = new Map<string, number[]>()
  for (const s of sceneRows) if (s.imageId) byImage.set(s.imageId, [...(byImage.get(s.imageId) ?? []), s.n])
  const imgs = byImage.size ? h.db.select().from(images).where(inArray(images.id, [...byImage.keys()])).all() : []
  const out: LicenseEntry[] = [...byImage.keys()]
    .map((id) => imgs.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => ({
      kind: 'image',
      assetId: i.id,
      scenes: byImage.get(i.id) ?? [],
      source: i.source,
      author: i.author,
      sourceUrl: i.sourceUrl,
      license: i.license,
      requiresCredit: i.requiresCredit,
      creditText: i.creditText,
      status: status(i.license, i.requiresCredit, i.creditText),
    }))
  const job = h.db.select().from(jobs).where(eq(jobs.videoId, videoId)).get()
  const cp = videoCheckpointSchema.safeParse(job?.checkpoint)
  const musicId = cp.success ? cp.data.audio?.musicId : undefined
  const m = musicId ? h.db.select().from(audioAssets).where(eq(audioAssets.id, musicId)).get() : undefined
  if (m) {
    out.push({
      kind: 'music',
      assetId: m.id,
      scenes: [],
      source: path.basename(m.path).startsWith('mudo-') ? 'MUDO (trilha embutida)' : 'acervo do usuário',
      author: null,
      sourceUrl: null,
      license: m.license,
      requiresCredit: m.requiresCredit,
      creditText: m.creditText,
      status: status(m.license, m.requiresCredit, m.creditText),
    })
  }
  return out
}

export function videosWithLicenses(h: DbHandle): Array<{ id: string; title: string | null; theme: string; state: string; createdAt: number }> {
  return h.db
    .select({ id: videos.id, title: videos.title, theme: videos.theme, state: videos.state, createdAt: videos.createdAt })
    .from(videos)
    .all()
    .sort((a, b) => b.createdAt - a.createdAt)
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV (UTF-8 com BOM, abre certo no Excel) com todas as licenças de um ou mais vídeos. */
export function licensesCsv(h: DbHandle, videoIds: string[]): string {
  const head = ['video_id', 'titulo', 'tipo', 'cenas', 'fonte', 'autor', 'url_origem', 'licenca', 'exige_credito', 'credito', 'situacao']
  const rows: string[] = [head.join(',')]
  for (const id of videoIds) {
    const v = h.db.select().from(videos).where(eq(videos.id, id)).get()
    if (!v) continue
    for (const e of videoLicenses(h, id)) {
      rows.push(
        [id, v.title ?? v.theme, e.kind === 'image' ? 'imagem' : 'musica', e.scenes.join(' '), e.source, e.author, e.sourceUrl, e.license ?? 'SEM LICENCA', e.requiresCredit ? 'sim' : 'nao', e.creditText, e.status]
          .map(csvCell)
          .join(','),
      )
    }
  }
  return `﻿${rows.join('\r\n')}\r\n`
}

export function writeLicensesCsv(h: DbHandle, videoIds: string[], file: string): number {
  const csv = licensesCsv(h, videoIds)
  writeFileAtomic(file, csv)
  return csv.split('\r\n').length - 2
}

export const licenseCreditSchema = z.object({ imageId: z.string(), credit: z.string().trim().min(1).max(300) })

/** Corrige o texto de crédito de uma imagem já usada (resolve LICENSE_MISSING). */
export function setImageCredit(h: DbHandle, imageId: string, credit: string): void {
  if (!h.db.select().from(images).where(eq(images.id, imageId)).get()) throw new Error('imagem não encontrada')
  h.db.update(images).set({ creditText: credit.trim() }).where(eq(images.id, imageId)).run()
}
