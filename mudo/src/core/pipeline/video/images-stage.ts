import { eq, inArray } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { MIN_IMAGE_WIDTH } from '../../../shared/enums'
import { credits, images, scenes } from '../../db/schema'
import type { EmbeddingProvider } from '../../images/embeddings'
import { vecToBlob } from '../../images/embeddings'
import { findLocalMatch, imageSize, markUsed, type ImageRow } from '../../images/library'
import { isSameImage, phash } from '../../images/phash'
import type { ImageGenProvider, StockCandidate, StockProvider } from '../../images/stock'
import { buildSceneQueriesPrompt, sceneQueriesJsonSchema, sceneQueriesSchema } from '../../prompts/scenes'
import { callWithFallback } from '../../providers/call'
import { stripJsonFences } from '../../providers/types'
import { JobError, NeedsInputError } from '../../queue/errors'
import { getSetting } from '../../settings'
import { splitActIntoScenes } from './split'
import { loadActs, loadScenes, type VideoJobState } from './state'

/** 8.3 — divide os atos em cenas e pede ao LLM uma busca visual concreta por cena. */
async function buildScenes(st: VideoJobState): Promise<void> {
  const { ctx } = st
  const actRows = loadActs(st)
  if (actRows.length === 0) throw new JobError('INTERNAL', 'roteiro sem atos')
  const planned: Array<{ actId: string; n: number; text: string }> = []
  for (const a of actRows) {
    for (const s of splitActIntoScenes(a.text, st.payload.wpm)) planned.push({ actId: a.id, n: planned.length + 1, text: s.text })
  }

  const providers = await ctx.providers.llm()
  const { system, prompt } = buildSceneQueriesPrompt({ language: st.language, theme: st.video.theme, scenes: planned })
  let queries: Map<number, string> | null = null
  let lastError = ''
  for (let attempt = 1; attempt <= 2 && !queries; attempt++) {
    const p = attempt === 1 ? prompt : `${prompt}\n\nYour previous answer was invalid: ${lastError}. Return exactly ${planned.length} entries, n = 1..${planned.length}.`
    const r = await callWithFallback(providers, () => ({ system, prompt: p, jsonSchema: sceneQueriesJsonSchema as unknown as Record<string, unknown>, expectedOutputTokens: planned.length * 20 + 100 }), {
      db: ctx.db,
      log: ctx.log,
      signal: ctx.signal,
      stage: 'images',
      videoId: st.video.id,
    })
    ctx.addCost(r.output.costCents)
    try {
      const parsed = sceneQueriesSchema.parse(JSON.parse(stripJsonFences(r.output.text)))
      const map = new Map(parsed.scenes.map((s) => [s.n, s.image_query]))
      const missing = planned.filter((s) => !map.has(s.n)).map((s) => s.n)
      if (missing.length > 0) lastError = `faltam as cenas ${missing.slice(0, 10).join(', ')}`
      else queries = map
    } catch (e) {
      lastError = e instanceof Error ? e.message.slice(0, 300) : String(e)
    }
  }
  if (!queries) throw new JobError('SCRIPT_SCHEMA', `Não foi possível obter as buscas de imagem das cenas: ${lastError}`)

  const db = ctx.db
  db.sqlite.transaction(() => {
    db.db.delete(scenes).where(eq(scenes.videoId, st.video.id)).run()
    for (const s of planned) {
      db.db
        .insert(scenes)
        .values({ id: randomUUID(), videoId: st.video.id, actId: s.actId, n: s.n, text: s.text, imageQuery: queries.get(s.n) ?? null, motion: null, approved: false })
        .run()
    }
  })()
  st.cp.scenes = { done: true, count: planned.length }
  st.save()
}

/** Limiares de similaridade (configuráveis): a escala do cosseno depende do modelo. */
function thresholds(st: VideoJobState, emb: EmbeddingProvider) {
  const clip = emb.model.startsWith('clip:')
  return {
    local: getSetting(st.ctx.db, 'images.localThreshold', z.number().min(-1).max(1), clip ? 0.26 : 0.45),
    stock: getSetting(st.ctx.db, 'images.stockThreshold', z.number().min(-1).max(1), clip ? 0.18 : 0.3),
  }
}

interface Used {
  ids: Set<string>
  phashes: string[]
}

/** Pontua candidatos pela PRÉVIA, em memória; só a escolhida é baixada em tamanho cheio (seção 7). */
async function bestStockCandidate(
  st: VideoJobState,
  p: StockProvider,
  emb: EmbeddingProvider,
  query: Float32Array,
  queryText: string,
  used: Used,
  min: number,
): Promise<{ c: StockCandidate; score: number; hash: string; vec: Float32Array } | { existing: ImageRow } | null> {
  const { ctx } = st
  let res
  try {
    res = await callWithFallback([p], () => ({ query: queryText, perPage: 15 }), {
      db: ctx.db,
      log: ctx.log,
      signal: ctx.signal,
      stage: 'images',
      videoId: st.video.id,
    })
  } catch (err) {
    if (err instanceof JobError && err.code === 'PROVIDER_UNAVAILABLE') return null
    throw err
  }
  const cands = res.output.candidates.filter((c) => c.width >= MIN_IMAGE_WIDTH && c.width >= c.height).slice(0, 8)
  let best: { c: StockCandidate; score: number; hash: string; vec: Float32Array } | null = null
  for (const c of cands) {
    if (ctx.signal.aborted) throw ctx.signal.reason
    const known = ctx.db.db.select().from(images).where(eq(images.sourceId, c.sourceId)).all().find((r) => r.source === p.id)
    if (known) {
      if (!used.ids.has(known.id) && !used.phashes.some((h) => isSameImage(h, known.phash)) && fs.existsSync(known.path)) return { existing: known }
      continue
    }
    let preview: Buffer
    try {
      preview = await p.download(c.previewUrl, ctx.signal)
    } catch (err) {
      if (ctx.signal.aborted) throw err
      ctx.log.warn({ provider: p.id, err: err instanceof Error ? err.message : String(err) }, 'prévia indisponível')
      continue
    }
    const hash = await phash(preview)
    if (used.phashes.some((h) => isSameImage(h, hash))) continue
    const vec = emb.embedImage ? await emb.embedImage(preview) : (await emb.embedTexts([c.description || queryText]))[0]!
    let score = 0
    for (let i = 0; i < vec.length; i++) score += vec[i]! * query[i]!
    if (score >= min && (!best || score > best.score)) best = { c, score, hash, vec }
  }
  return best
}

async function saveStock(st: VideoJobState, p: StockProvider, pick: { c: StockCandidate; hash: string; vec: Float32Array }, emb: EmbeddingProvider): Promise<ImageRow | null> {
  const { ctx } = st
  const full = await p.download(pick.c.downloadUrl, ctx.signal)
  const size = await imageSize(full)
  if (size.width < MIN_IMAGE_WIDTH) return null
  const file = path.join(ctx.paths.stock, `${p.id}-${pick.c.sourceId}.jpg`)
  await sharp(full).rotate().jpeg({ quality: 92 }).toFile(`${file}.part`)
  fs.renameSync(`${file}.part`, file)
  const id = randomUUID()
  // licença, autor e URL de origem gravados na hora (seção 8.4)
  ctx.db.db
    .insert(images)
    .values({
      id,
      path: file,
      source: p.id,
      sourceId: pick.c.sourceId,
      sourceUrl: pick.c.pageUrl,
      author: pick.c.author,
      license: p.license,
      requiresCredit: p.requiresCredit,
      creditText: p.credit(pick.c),
      phash: await phash(full),
      embedding: vecToBlob(pick.vec),
      embeddingModel: emb.model,
      description: pick.c.description || null,
      width: size.width,
      height: size.height,
      createdAt: Date.now(),
    })
    .run()
  return ctx.db.db.select().from(images).where(eq(images.id, id)).get() ?? null
}

async function generate(st: VideoJobState, gen: ImageGenProvider[], emb: EmbeddingProvider, queryText: string, used: Used): Promise<ImageRow | null> {
  const { ctx } = st
  if (gen.length === 0) return null
  const r = await callWithFallback(gen, () => ({ prompt: `Photorealistic 16:9 photograph: ${queryText}. Natural light, no text, no logos, no watermark.` }), {
    db: ctx.db,
    log: ctx.log,
    signal: ctx.signal,
    stage: 'images',
    videoId: st.video.id,
  })
  ctx.addCost(r.output.costCents)
  const hash = await phash(r.output.image)
  if (used.phashes.some((h) => isSameImage(h, hash))) return null
  const id = randomUUID()
  const file = path.join(ctx.paths.generated, `${id}.jpg`)
  await sharp(r.output.image).jpeg({ quality: 92 }).toFile(file)
  const size = await imageSize(file)
  const vec = emb.embedImage ? await emb.embedImage(file) : (await emb.embedTexts([queryText]))[0]!
  ctx.db.db
    .insert(images)
    .values({
      id,
      path: file,
      source: r.providerId,
      license: 'generated',
      requiresCredit: false,
      creditText: 'Imagem gerada por IA',
      phash: hash,
      embedding: vecToBlob(vec),
      embeddingModel: emb.model,
      description: queryText,
      width: size.width,
      height: size.height,
      createdAt: Date.now(),
    })
    .run()
  return ctx.db.db.select().from(images).where(eq(images.id, id)).get() ?? null
}

/** 8.4 — por cena: acervo → Pexels → Pixabay → geração por IA. Nunca repete imagem no vídeo. */
async function chooseImages(st: VideoJobState): Promise<void> {
  const { ctx } = st
  const rows = loadScenes(st)
  const emb = await ctx.providers.embeddings()
  const stock = await ctx.providers.stock()
  const gen = await ctx.providers.imageGen()
  const th = thresholds(st, emb)

  const chosenIds = rows.map((r) => r.imageId).filter((x): x is string => !!x)
  const chosenRows = chosenIds.length ? ctx.db.db.select().from(images).where(inArray(images.id, chosenIds)).all() : []
  const used: Used = { ids: new Set(chosenIds), phashes: chosenRows.map((r) => r.phash).filter((x): x is string => !!x) }

  const pending = rows.filter((r) => !r.imageId)
  const queries = await emb.embedTexts(pending.map((r) => r.imageQuery ?? r.text), ctx.signal)
  let done = rows.length - pending.length

  for (let i = 0; i < pending.length; i++) {
    const scene = pending[i]!
    const q = queries[i]!
    const qText = scene.imageQuery ?? scene.text
    let pick: ImageRow | null = findLocalMatch(ctx.db, { model: emb.model, query: q, usedIds: used.ids, usedPhashes: used.phashes, threshold: th.local })?.row ?? null
    let origin = 'acervo'
    for (const p of stock) {
      if (pick) break
      const b = await bestStockCandidate(st, p, emb, q, qText, used, th.stock)
      if (!b) continue
      pick = 'existing' in b ? b.existing : await saveStock(st, p, b, emb)
      origin = p.id
    }
    if (!pick) {
      pick = await generate(st, gen, emb, qText, used)
      origin = 'gerada'
    }
    if (!pick) {
      throw new NeedsInputError(
        'IMAGES_UNAVAILABLE',
        `Não encontrei imagem com licença para a cena ${scene.n} ("${qText}"). Importe imagens para o acervo (mudo images import) ou configure Pexels/Pixabay/OpenAI e retome.`,
        { scene: scene.n, query: qText },
      )
    }
    ctx.db.db.update(scenes).set({ imageId: pick.id }).where(eq(scenes.id, scene.id)).run()
    markUsed(ctx.db, pick.id)
    used.ids.add(pick.id)
    if (pick.phash) used.phashes.push(pick.phash)
    done++
    ctx.log.debug({ scene: scene.n, image: pick.id, origin }, 'imagem escolhida')
    ctx.stageProgress(0.2 + 0.8 * (done / rows.length))
  }
}

/** Créditos do vídeo: imagens com texto de crédito, na ordem em que aparecem (seção 8.7). */
function rebuildCredits(st: VideoJobState): void {
  const { ctx } = st
  const rows = loadScenes(st)
  const ids = [...new Set(rows.map((r) => r.imageId).filter((x): x is string => !!x))]
  const imgs = new Map((ids.length ? ctx.db.db.select().from(images).where(inArray(images.id, ids)).all() : []).map((r) => [r.id, r]))
  const texts: string[] = []
  for (const id of ids) {
    const t = imgs.get(id)?.creditText?.trim()
    if (t && !texts.includes(t)) texts.push(t)
  }
  ctx.db.sqlite.transaction(() => {
    ctx.db.db.delete(credits).where(eq(credits.videoId, st.video.id)).run()
    texts.forEach((text, position) => ctx.db.db.insert(credits).values({ videoId: st.video.id, text, position }).run())
  })()
}

export async function imagesStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('images')
  if (!st.cp.scenes?.done || loadScenes(st).length === 0) await buildScenes(st)
  ctx.stageProgress(0.2)
  await chooseImages(st)
  rebuildCredits(st)
  ctx.stageProgress(1)
}
