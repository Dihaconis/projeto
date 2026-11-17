import { desc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { channelInputSchema, stylePresetSchema, type ChannelInput, type StylePreset } from '../shared/channel'
import type { DbHandle } from './db'
import { channels, videos } from './db/schema'
import { JobError } from './queue/errors'

export type ChannelRow = typeof channels.$inferSelect

export function createChannel(h: DbHandle, input: ChannelInput): ChannelRow {
  const c = channelInputSchema.parse(input)
  return h.db
    .insert(channels)
    .values({
      id: randomUUID(),
      name: c.name,
      niche: c.niche,
      language: c.language,
      ttsProvider: c.ttsProvider ?? null,
      voiceId: c.voiceId ?? null,
      musicMood: c.musicMood ?? null,
      stylePreset: stylePresetSchema.parse(c.stylePreset ?? {}),
      status: 'active',
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

export function getChannel(h: DbHandle, id: string): ChannelRow | undefined {
  return h.db.select().from(channels).where(eq(channels.id, id)).get()
}

/** Canais ativos (arquivados ficam fora das listas). */
export function listChannels(h: DbHandle): ChannelRow[] {
  return h.db.select().from(channels).where(eq(channels.status, 'active')).orderBy(desc(channels.createdAt)).all()
}

export function channelPreset(c: ChannelRow): StylePreset {
  const r = stylePresetSchema.safeParse(c.stylePreset ?? {})
  return r.success ? r.data : stylePresetSchema.parse({})
}

/** Atualiza nome, nicho, idioma, voz, trilha e preset do canal (tela Canais, seção 10). */
export function updateChannel(h: DbHandle, id: string, input: ChannelInput): ChannelRow {
  const existing = getChannel(h, id)
  if (!existing) throw new JobError('INVALID_INPUT', 'canal não encontrado')
  const parsed = channelInputSchema.safeParse(input)
  if (!parsed.success) throw new JobError('INVALID_INPUT', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const c = parsed.data
  h.db
    .update(channels)
    .set({
      name: c.name,
      niche: c.niche,
      language: c.language,
      ttsProvider: c.ttsProvider ?? null,
      voiceId: c.voiceId ?? null,
      musicMood: c.musicMood ?? null,
      stylePreset: stylePresetSchema.parse(c.stylePreset ?? {}),
    })
    .where(eq(channels.id, id))
    .run()
  return getChannel(h, id)!
}

/**
 * Remove o canal. Com vídeos, ele é arquivado (some das listas, os vídeos e a
 * biblioteca continuam íntegros); sem vídeos, é apagado.
 */
export function removeChannel(h: DbHandle, id: string): 'deleted' | 'archived' {
  if (!getChannel(h, id)) throw new JobError('INVALID_INPUT', 'canal não encontrado')
  const used = h.db.select({ id: videos.id }).from(videos).where(eq(videos.channelId, id)).limit(1).get()
  if (used) {
    h.db.update(channels).set({ status: 'archived' }).where(eq(channels.id, id)).run()
    return 'archived'
  }
  h.db.delete(channels).where(eq(channels.id, id)).run()
  return 'deleted'
}
