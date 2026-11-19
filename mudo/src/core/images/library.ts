import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { LIBRARY_LICENSES, MIN_IMAGE_WIDTH, VIDEO_SPEC, type ImageLicense } from '../../shared/enums'
import type { DbHandle } from '../db'
import { images } from '../db/schema'
import type { DataPaths } from '../paths'
import { JobError } from '../queue/errors'
import { blobToVec, cosine, vecToBlob, type EmbeddingProvider } from './embeddings'
import { isSameImage, phash } from './phash'

export type ImageRow = typeof images.$inferSelect
export type LibraryLicense = (typeof LIBRARY_LICENSES)[number]

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

/** Largura/altura já considerando a orientação EXIF. */
export async function imageSize(input: string | Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(input).metadata()
  const rotated = (m.orientation ?? 1) >= 5
  const w = m.width ?? 0
  const h = m.height ?? 0
  return rotated ? { width: h, height: w } : { width: w, height: h }
}

/** Texto que representa a imagem quando o modelo de embedding só lê texto. */
function textFor(file: string, description: string | null): string {
  if (description?.trim()) return description
  return path.parse(file).name.replace(/[_\-.]+/g, ' ')
}

export async function embedImageRow(emb: EmbeddingProvider, file: string | Buffer, description: string | null, nameHint: string): Promise<Float32Array> {
  if (emb.embedImage) return emb.embedImage(file)
  const [v] = await emb.embedTexts([textFor(nameHint, description)])
  return v!
}

export interface ImportResult {
  file: string
  status: 'imported' | 'updated' | 'rejected'
  id?: string
  reason?: string
  quarantined?: boolean
}

export interface ImportOptions {
  /** Licença escolhida pelo usuário para a pasta/arquivo; ausente = quarentena. */
  license?: LibraryLicense | null
  author?: string | null
  credit?: string | null
}

function validateCredit(license: ImageLicense | null | undefined, credit: string | null | undefined) {
  // "own", "cc0" e "public_domain" não exigem crédito; se o usuário informar, entra na cartela
  return { requiresCredit: !!credit?.trim() && license !== null, creditText: credit?.trim() || null }
}

/**
 * Importa uma imagem do acervo local (seção 9): mantém o arquivo onde está,
 * calcula pHash e embedding. Sem licença → quarentena (nunca é usada).
 */
export async function importImageFile(h: DbHandle, emb: EmbeddingProvider, file: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const abs = path.resolve(file)
  if (!EXTENSIONS.has(path.extname(abs).toLowerCase())) return { file: abs, status: 'rejected', reason: 'formato não suportado (use JPG, PNG ou WebP)' }
  let size: { width: number; height: number }
  try {
    size = await imageSize(abs)
  } catch {
    return { file: abs, status: 'rejected', reason: 'arquivo de imagem ilegível' }
  }
  if (size.width < MIN_IMAGE_WIDTH) return { file: abs, status: 'rejected', reason: `largura ${size.width}px abaixo do mínimo de ${MIN_IMAGE_WIDTH}px` }

  const existing = h.db.select().from(images).where(eq(images.path, abs)).get()
  const license = opts.license ?? null
  const credit = validateCredit(license, opts.credit)
  if (existing) {
    if (opts.license !== undefined) {
      h.db
        .update(images)
        .set({ license, author: opts.author ?? existing.author, ...credit })
        .where(eq(images.id, existing.id))
        .run()
    }
    return { file: abs, status: 'updated', id: existing.id, quarantined: (opts.license !== undefined ? license : existing.license) === null }
  }

  const [hash, vec] = await Promise.all([phash(abs), embedImageRow(emb, abs, null, abs)])
  const id = randomUUID()
  h.db
    .insert(images)
    .values({
      id,
      path: abs,
      source: 'library',
      license,
      author: opts.author ?? null,
      ...credit,
      phash: hash,
      embedding: vecToBlob(vec),
      embeddingModel: emb.model,
      width: size.width,
      height: size.height,
      createdAt: Date.now(),
    })
    .run()
  return { file: abs, status: 'imported', id, quarantined: license === null }
}

export async function importFolder(h: DbHandle, emb: EmbeddingProvider, dir: string, opts: ImportOptions = {}, onFile?: (r: ImportResult) => void): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile() || !EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue
    const r = await importImageFile(h, emb, path.join(e.parentPath, e.name), opts)
    out.push(r)
    onFile?.(r)
  }
  return out
}

/** Licença por arquivo, escolhida pelo usuário (só licenças de acervo próprio). */
export function setImageLicense(h: DbHandle, id: string, license: LibraryLicense | null, credit?: string | null, author?: string | null): ImageRow {
  const row = h.db.select().from(images).where(eq(images.id, id)).get()
  if (!row) throw new JobError('INVALID_INPUT', `imagem não encontrada: ${id}`)
  if (row.source !== 'library') throw new JobError('INVALID_INPUT', 'só imagens do acervo local têm a licença escolhida pelo usuário')
  h.db
    .update(images)
    .set({ license, ...validateCredit(license, credit), ...(author !== undefined ? { author } : {}) })
    .where(eq(images.id, id))
    .run()
  return h.db.select().from(images).where(eq(images.id, id)).get()!
}

export function listImages(h: DbHandle, filter: { quarantine?: boolean } = {}): ImageRow[] {
  const q = h.db.select().from(images)
  const rows = filter.quarantine ? q.where(isNull(images.license)).all() : q.where(ne(images.source, 'mudo')).all()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export interface MatchOptions {
  model: string
  query: Float32Array
  /** Imagens já escolhidas neste vídeo (por id e por pHash: nunca repetir). */
  usedIds: ReadonlySet<string>
  usedPhashes: readonly string[]
  threshold: number
  now?: number
}

/** Penalidade por uso recente (seção 8.4): até −0,10 para imagens muito usadas nos últimos 30 dias. */
export function recencyPenalty(usedCount: number, lastUsedAt: number | null, now: number): number {
  if (!lastUsedAt || now - lastUsedAt > 30 * 86_400_000) return 0
  return Math.min(0.1, 0.02 * usedCount)
}

/**
 * 8.4 passo 1 — melhor imagem do acervo (local + o que já foi baixado antes)
 * por cosseno, com penalidade de uso recente. Só imagens com licença, largura
 * ≥ 1280 px, arquivo presente e embedding do mesmo modelo.
 */
export function findLocalMatch(h: DbHandle, o: MatchOptions): { row: ImageRow; score: number } | null {
  const now = o.now ?? Date.now()
  const rows = h.db
    .select()
    .from(images)
    .where(
      and(
        isNotNull(images.license),
        eq(images.embeddingModel, o.model),
        ne(images.source, 'mudo'),
        sql`${images.width} >= ${MIN_IMAGE_WIDTH}`,
      ),
    )
    .all()
  let best: { row: ImageRow; score: number } | null = null
  for (const r of rows) {
    if (o.usedIds.has(r.id)) continue
    if (r.requiresCredit && !r.creditText) continue
    if (o.usedPhashes.some((p) => isSameImage(p, r.phash))) continue
    const v = blobToVec(r.embedding)
    if (!v) continue
    const score = cosine(o.query, v) - recencyPenalty(r.usedCount, r.lastUsedAt, now)
    if (score >= o.threshold && (!best || score > best.score) && fs.existsSync(r.path)) best = { row: r, score }
  }
  return best
}

export function markUsed(h: DbHandle, id: string, now = Date.now()): void {
  h.db
    .update(images)
    .set({ usedCount: sql`${images.usedCount} + 1`, lastUsedAt: now })
    .where(eq(images.id, id))
    .run()
}

/**
 * Quadro 4K 16:9 da imagem, com recorte inteligente (atenção) — a base do
 * zoompan sem tremor (seção 8.6). Cacheado por imagem e reaproveitado.
 */
export async function preparedFrame(paths: DataPaths, img: Pick<ImageRow, 'id' | 'path'>): Promise<string> {
  const out = path.join(paths.frames, `${img.id}.jpg`)
  if (fs.existsSync(out)) return out
  fs.mkdirSync(paths.frames, { recursive: true })
  const tmp = `${out}.${process.pid}.part`
  await sharp(img.path)
    .rotate()
    .resize(VIDEO_SPEC.width * 2, VIDEO_SPEC.height * 2, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 90 })
    .toFile(tmp)
  fs.renameSync(tmp, out)
  return out
}
