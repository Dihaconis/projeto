import { desc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { videoRequestSchema, type VideoRequest } from '../shared/channel'
import { DEFAULT_WPM, LANGUAGES, type Language } from '../shared/enums'
import { getChannel, type ChannelRow } from './channels'
import type { DbHandle } from './db'
import { videos } from './db/schema'
import { buildScriptPrompt, scriptJsonSchema } from './prompts/script'
import type { ProviderSource } from './providers/registry'
import { JobQueue, type JobRow } from './queue/queue'
import { JobError } from './queue/errors'
import { assertQuota } from './quota'
import { getSetting } from './settings'

export type VideoRow = typeof videos.$inferSelect

export const videoPayloadSchema = z.object({
  wpm: z.number().int().min(80).max(260),
})
export type VideoPayload = z.infer<typeof videoPayloadSchema>

export function wpmFor(h: DbHandle, lang: Language): number {
  return getSetting(h, `speech.wpm.${lang}`, z.number().int().min(80).max(260), DEFAULT_WPM[lang])
}

export function targetWords(durationS: number, wpm: number): number {
  return Math.round((durationS / 60) * wpm)
}

interface Resolved {
  channel: ChannelRow
  theme: string
  language: Language
  durationS: number
}

function resolve(h: DbHandle, req: VideoRequest): Resolved {
  const parsed = videoRequestSchema.safeParse(req)
  if (!parsed.success) throw new JobError('INVALID_INPUT', parsed.error.issues.map((i) => i.message).join('; '))
  const channel = getChannel(h, parsed.data.channelId)
  if (!channel) throw new JobError('INVALID_INPUT', `canal não encontrado: ${parsed.data.channelId}`)
  const lang = parsed.data.language ?? z.enum(LANGUAGES).parse(channel.language)
  return { channel, theme: parsed.data.theme, language: lang, durationS: parsed.data.durationS }
}

/** Cria o vídeo e enfileira o job numa transação. */
export function createVideoJob(h: DbHandle, req: VideoRequest): { video: VideoRow; job: JobRow } {
  const r = resolve(h, req)
  const payload: VideoPayload = { wpm: wpmFor(h, r.language) }
  return h.sqlite.transaction(() => {
    assertQuota(h, 'video')
    const now = Date.now()
    const video = h.db
      .insert(videos)
      .values({
        id: randomUUID(),
        channelId: r.channel.id,
        theme: r.theme,
        language: r.language,
        targetDurationS: r.durationS,
        state: 'queued',
        stage: null,
        progress: 0,
        costCents: 0,
        createdAt: now,
      })
      .returning()
      .get()
    const job = new JobQueue(h).enqueue({ kind: 'video', videoId: video.id, payload })
    return { video, job }
  })()
}

export function getVideo(h: DbHandle, id: string): VideoRow | undefined {
  return h.db.select().from(videos).where(eq(videos.id, id)).get()
}

export function listVideos(h: DbHandle, limit = 500): VideoRow[] {
  return h.db.select().from(videos).orderBy(desc(videos.createdAt)).limit(limit).all()
}

export interface CostEstimate {
  totalCents: number
  breakdown: Array<{ stage: string; provider: string | null; cents: number }>
  missing: string[]
}

/**
 * Custo estimado antes de enfileirar (seção 7): soma de `estimateCost` do
 * primeiro provedor de cada etapa — roteiro, revisão (até 2), cenas e TTS.
 */
export async function estimateVideoCost(h: DbHandle, providers: ProviderSource, req: VideoRequest): Promise<CostEstimate> {
  const r = resolve(h, req)
  const words = targetWords(r.durationS, wpmFor(h, r.language))
  const scriptTokens = Math.round(words * 1.6)
  const [llm] = await providers.llm()
  const [tts] = await providers.tts()
  const breakdown: CostEstimate['breakdown'] = []
  const missing: string[] = []
  if (llm) {
    const p = buildScriptPrompt({
      theme: r.theme,
      language: r.language,
      targetS: r.durationS,
      targetWords: words,
      channel: { name: r.channel.name, niche: r.channel.niche },
      recentTitles: [],
    })
    const script = llm.estimateCost({ ...p, jsonSchema: scriptJsonSchema, expectedOutputTokens: scriptTokens + 200 })
    const review = llm.estimateCost({ system: '', prompt: 'x'.repeat(scriptTokens * 4 + 3000), jsonSchema: {}, expectedOutputTokens: scriptTokens })
    const scenes = llm.estimateCost({ system: '', prompt: 'x'.repeat(scriptTokens * 4 + 1500), jsonSchema: {}, expectedOutputTokens: Math.round(words / 2) })
    breakdown.push({ stage: 'script', provider: llm.id, cents: script })
    breakdown.push({ stage: 'review', provider: llm.id, cents: review * 2 })
    breakdown.push({ stage: 'images', provider: llm.id, cents: scenes })
  } else missing.push('llm')
  if (tts) {
    const chars = Math.round(words * 6.2)
    breakdown.push({ stage: 'tts', provider: tts.id, cents: tts.estimateCost({ text: 'x'.repeat(chars), voiceId: '', language: r.language }) })
  } else missing.push('tts')
  const totalCents = breakdown.reduce((s, b) => s + b.cents, 0)
  return { totalCents, breakdown, missing }
}
