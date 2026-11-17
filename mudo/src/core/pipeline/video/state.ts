import { and, asc, eq } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { LANGUAGES, type Language } from '../../../shared/enums'
import { channelPreset, getChannel, type ChannelRow } from '../../channels'
import { acts, scenes, videos } from '../../db/schema'
import { writeFileAtomic } from '../../paths'
import { reviewSchema } from '../../prompts/review'
import { scriptSchema, type Script } from '../../prompts/script'
import { JobError } from '../../queue/errors'
import { getVideo, videoPayloadSchema, type VideoPayload, type VideoRow } from '../../videos'
import type { JobContext } from '../context'

/** Checkpoint do job de vídeo: o que já está pronto e não deve ser refeito. */
export const videoCheckpointSchema = z.object({
  script: z.object({ done: z.literal(true) }).optional(),
  review: z
    .object({
      status: z.enum(['approved', 'pending_human', 'human']),
      rounds: z.number().int(),
      issues: reviewSchema.shape.issues,
    })
    .optional(),
  scenes: z.object({ done: z.literal(true), count: z.number().int() }).optional(),
  tts: z.object({ provider: z.string(), voiceId: z.string() }).optional(),
  narration: z.object({ totalMs: z.number(), tempo: z.number() }).optional(),
  segments: z.record(z.string(), z.literal(true)).default({}),
  /** Trilha escolhida e áudio final (mix + loudnorm) pronto. */
  audio: z.object({ musicId: z.string() }).optional(),
  output: z.object({ mp4: z.string(), txt: z.string() }).optional(),
  /** Cota do mês já debitada por este vídeo (débito só uma vez). */
  quotaConsumed: z.literal(true).optional(),
})
export type VideoCheckpoint = z.infer<typeof videoCheckpointSchema>

export interface VideoJobState {
  ctx: JobContext
  video: VideoRow
  channel: ChannelRow
  language: Language
  payload: VideoPayload
  cp: VideoCheckpoint
  save(): void
  /** Caminhos de trabalho deste vídeo. */
  files: {
    script: string
    review: string
    narration: string
    image: string
    ttsDir: string
    segmentsDir: string
  }
}

export function loadVideoJob(ctx: JobContext): VideoJobState {
  const videoId = ctx.job.videoId
  if (!videoId) throw new JobError('INTERNAL', 'job de vídeo sem video_id')
  const video = getVideo(ctx.db, videoId)
  if (!video) throw new JobError('INTERNAL', `vídeo ${videoId} não existe`)
  const channel = getChannel(ctx.db, video.channelId)
  if (!channel) throw new JobError('INVALID_INPUT', 'o canal deste vídeo foi apagado')
  const parsed = videoCheckpointSchema.safeParse(ctx.checkpoint<unknown>() ?? {})
  const cp = parsed.success ? parsed.data : videoCheckpointSchema.parse({})
  const st: VideoJobState = {
    ctx,
    video,
    channel,
    language: z.enum(LANGUAGES).parse(video.language),
    payload: videoPayloadSchema.parse(ctx.job.payload),
    cp,
    save: () => ctx.saveCheckpoint(cp),
    files: {
      script: path.join(ctx.workDir, 'script.json'),
      review: path.join(ctx.workDir, 'review.json'),
      narration: path.join(ctx.workDir, 'narration.wav'),
      image: path.join(ctx.workDir, 'images', 'fixed.png'),
      ttsDir: path.join(ctx.workDir, 'tts'),
      segmentsDir: path.join(ctx.workDir, 'segments'),
    },
  }
  return st
}

export function refreshVideo(st: VideoJobState): VideoRow {
  const v = getVideo(st.ctx.db, st.video.id)
  if (!v) throw new JobError('INTERNAL', 'vídeo sumiu durante o job')
  st.video = v
  return v
}

export function readScript(st: VideoJobState): Script {
  if (!fs.existsSync(st.files.script)) throw new JobError('INTERNAL', 'roteiro ausente na pasta de trabalho')
  return scriptSchema.parse(JSON.parse(fs.readFileSync(st.files.script, 'utf8')))
}

export function writeScript(st: VideoJobState, s: Script): void {
  writeFileAtomic(st.files.script, JSON.stringify(s, null, 2))
}

export function loadActs(st: VideoJobState) {
  return st.ctx.db.db.select().from(acts).where(eq(acts.videoId, st.video.id)).orderBy(asc(acts.n)).all()
}

export function loadScenes(st: VideoJobState) {
  return st.ctx.db.db.select().from(scenes).where(eq(scenes.videoId, st.video.id)).orderBy(asc(scenes.n)).all()
}

export function updateScene(st: VideoJobState, id: string, patch: Partial<typeof scenes.$inferInsert>): void {
  st.ctx.db.db.update(scenes).set(patch).where(and(eq(scenes.id, id), eq(scenes.videoId, st.video.id))).run()
}

export function updateVideo(st: VideoJobState, patch: Partial<typeof videos.$inferInsert>): void {
  st.ctx.db.db.update(videos).set(patch).where(eq(videos.id, st.video.id)).run()
}

export function preset(st: VideoJobState) {
  return channelPreset(st.channel)
}
