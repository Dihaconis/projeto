import { desc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { channelInputSchema, stylePresetSchema, type ChannelInput, type StylePreset } from '../shared/channel'
import type { DbHandle } from './db'
import { channels } from './db/schema'

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

export function listChannels(h: DbHandle): ChannelRow[] {
  return h.db.select().from(channels).orderBy(desc(channels.createdAt)).all()
}

export function channelPreset(c: ChannelRow): StylePreset {
  const r = stylePresetSchema.safeParse(c.stylePreset ?? {})
  return r.success ? r.data : stylePresetSchema.parse({})
}
