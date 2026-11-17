import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { VIDEO_SPEC } from '../../../shared/enums'
import { images, scenes } from '../../db/schema'
import { runFfmpeg } from '../../media/ffmpeg'
import { buildSceneQueriesPrompt, sceneQueriesJsonSchema, sceneQueriesSchema } from '../../prompts/scenes'
import { callWithFallback } from '../../providers/call'
import { stripJsonFences } from '../../providers/types'
import { JobError } from '../../queue/errors'
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
    planned.forEach((s, i) => {
      db.db
        .insert(scenes)
        .values({
          id: randomUUID(),
          videoId: st.video.id,
          actId: s.actId,
          n: s.n,
          text: s.text,
          imageQuery: queries.get(s.n) ?? null,
          motion: null,
          approved: false,
        })
        .run()
      void i
    })
  })()
  st.cp.scenes = { done: true, count: planned.length }
  st.save()
}

/**
 * Imagem de fundo da Fase 2: gerada localmente (licença `own`, sem crédito) e
 * registrada no acervo como qualquer imagem. Na Fase 3 cada cena recebe a sua.
 */
async function ensureFixedImage(st: VideoJobState): Promise<string> {
  const { ctx } = st
  const existing = loadScenes(st).find((s) => s.imageId)?.imageId
  if (existing && fs.existsSync(st.files.image)) return existing
  fs.mkdirSync(path.dirname(st.files.image), { recursive: true })
  const tmp = path.join(ctx.tmpDir, 'fixed.png')
  fs.mkdirSync(ctx.tmpDir, { recursive: true })
  await runFfmpeg(
    ctx.spawn,
    ctx.media,
    ['-f', 'lavfi', '-i', `color=c=0x16202c:s=${VIDEO_SPEC.width}x${VIDEO_SPEC.height}:d=1`, '-vf', 'vignette=PI/4', '-frames:v', '1', tmp],
    { what: 'gerar a imagem de fundo' },
  )
  fs.renameSync(tmp, st.files.image)
  const id = randomUUID()
  ctx.db.db
    .insert(images)
    .values({
      id,
      path: st.files.image,
      source: 'mudo',
      license: 'own',
      requiresCredit: false,
      width: VIDEO_SPEC.width,
      height: VIDEO_SPEC.height,
      usedCount: 1,
      lastUsedAt: Date.now(),
    })
    .run()
  ctx.db.db.update(scenes).set({ imageId: id }).where(eq(scenes.videoId, st.video.id)).run()
  return id
}

export async function imagesStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('images')
  if (!st.cp.scenes?.done || loadScenes(st).length === 0) await buildScenes(st)
  ctx.stageProgress(0.5)
  await ensureFixedImage(st)
  ctx.stageProgress(1)
}
