import { sql } from 'drizzle-orm'
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { IMAGE_LICENSES, JOB_KINDS, JOB_STATES, STAGES } from '../../shared/enums'

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  niche: text('niche').notNull(),
  language: text('language').notNull(),
  voiceId: text('voice_id'),
  ttsProvider: text('tts_provider'),
  stylePreset: text('style_preset', { mode: 'json' }),
  musicMood: text('music_mood'),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull().default(now),
})

export const videos = sqliteTable('videos', {
  id: text('id').primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id),
  theme: text('theme').notNull(),
  language: text('language').notNull(),
  targetDurationS: integer('target_duration_s').notNull(),
  actualDurationS: real('actual_duration_s'),
  state: text('state').notNull(),
  stage: text('stage'),
  progress: real('progress').notNull().default(0),
  title: text('title'),
  description: text('description'),
  costCents: real('cost_cents').notNull().default(0),
  outputPath: text('output_path'),
  thumbPath: text('thumb_path'),
  genTimeS: real('gen_time_s'),
  createdAt: integer('created_at').notNull().default(now),
  finishedAt: integer('finished_at'),
})

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Tipo do job. */
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    /** Vídeo gerado por este job. */
    videoId: text('video_id').references(() => videos.id),
    state: text('state', { enum: JOB_STATES }).notNull(),
    stage: text('stage', { enum: STAGES }),
    progress: real('progress').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    checkpoint: text('checkpoint', { mode: 'json' }).notNull(),
    lastError: text('last_error', { mode: 'json' }),
    lockedBy: text('locked_by'),
    lockedAt: integer('locked_at'),
    heartbeatAt: integer('heartbeat_at'),
    costCents: real('cost_cents').notNull().default(0),
    stageTimings: text('stage_timings', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('jobs_state_idx').on(t.state)],
)

/**
 * Processos filhos vivos de cada job. Permite matar ffmpeg/whisper deixados
 * para trás quando o próprio runner morre (kill -9, queda de energia).
 */
export const jobProcs = sqliteTable(
  'job_procs',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    pid: integer('pid').notNull(),
    command: text('command').notNull(),
    startedAt: integer('started_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.pid] })],
)

export const acts = sqliteTable('acts', {
  id: text('id').primaryKey(),
  videoId: text('video_id')
    .notNull()
    .references(() => videos.id, { onDelete: 'cascade' }),
  n: integer('n').notNull(),
  heading: text('heading').notNull(),
  text: text('text').notNull(),
})

export const images = sqliteTable(
  'images',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    author: text('author'),
    /** Licença em enum fechado (seção 9). Nula = quarentena: a imagem não é usada. */
    license: text('license', { enum: IMAGE_LICENSES }),
    requiresCredit: integer('requires_credit', { mode: 'boolean' }).notNull().default(false),
    creditText: text('credit_text'),
    phash: text('phash'),
    embedding: blob('embedding', { mode: 'buffer' }),
    /** Modelo que gerou o embedding (só se compara vetor do mesmo modelo). */
    embeddingModel: text('embedding_model'),
    /** Descrição/alt do provedor (base do embedding quando o modelo só lê texto). */
    description: text('description'),
    /** Id da foto no provedor de banco de imagens (evita baixar duas vezes). */
    sourceId: text('source_id'),
    tags: text('tags', { mode: 'json' }),
    width: integer('width'),
    height: integer('height'),
    usedCount: integer('used_count').notNull().default(0),
    lastUsedAt: integer('last_used_at'),
    /** Preenchido na inserção (ALTER TABLE do SQLite não aceita default por expressão). */
    createdAt: integer('created_at').notNull().default(0),
  },
  (t) => [
    index('images_phash_idx').on(t.phash),
    index('images_last_used_at_idx').on(t.lastUsedAt),
    uniqueIndex('images_source_idx').on(t.source, t.sourceId),
    uniqueIndex('images_path_idx').on(t.path),
  ],
)

export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    actId: text('act_id')
      .notNull()
      .references(() => acts.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    text: text('text').notNull(),
    imageQuery: text('image_query'),
    imageId: text('image_id').references(() => images.id),
    audioPath: text('audio_path'),
    startMs: integer('start_ms'),
    endMs: integer('end_ms'),
    motion: text('motion'),
    approved: integer('approved', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('scenes_video_id_idx').on(t.videoId)],
)

export const audioAssets = sqliteTable('audio_assets', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  mood: text('mood'),
  license: text('license'),
  requiresCredit: integer('requires_credit', { mode: 'boolean' }).notNull().default(false),
  creditText: text('credit_text'),
})

export const credits = sqliteTable(
  'credits',
  {
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.videoId, t.position] })],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
})

export const usage = sqliteTable('usage', {
  month: text('month').primaryKey(),
  videosUsed: integer('videos_used').notNull().default(0),
  cutsUsed: integer('cuts_used').notNull().default(0),
})

export const providerLog = sqliteTable('provider_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  provider: text('provider').notNull(),
  model: text('model'),
  stage: text('stage'),
  videoId: text('video_id'),
  outcome: text('outcome', { enum: ['ok', 'error', 'refusal', 'timeout'] }).notNull(),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  chars: integer('chars'),
  costCents: real('cost_cents').notNull().default(0),
  latencyMs: integer('latency_ms'),
  createdAt: integer('created_at').notNull().default(now),
})
