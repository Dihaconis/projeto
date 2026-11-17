import { z } from 'zod'
import { secretIdSchema } from '../core/secrets'
import { channelInputSchema, stylePresetSchema, videoRequestSchema } from './channel'
import { ERROR_CODES, JOB_STATES, LANGUAGES, MUSIC_MOODS, STAGES } from './enums'
import { PLAN_IDS } from './plans'

/** Vídeo + job + canal, como as telas Meus Vídeos e Biblioteca mostram. */
export const videoViewSchema = z.object({
  id: z.string(),
  jobId: z.string().nullable(),
  channelId: z.string(),
  channelName: z.string(),
  theme: z.string(),
  title: z.string().nullable(),
  language: z.enum(LANGUAGES),
  state: z.enum(JOB_STATES),
  stage: z.enum(STAGES).nullable(),
  progress: z.number(),
  attempt: z.number().int(),
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).nullable(),
  targetDurationS: z.number(),
  durationS: z.number().nullable(),
  costCents: z.number(),
  genTimeS: z.number().nullable(),
  hasOutput: z.boolean(),
  hasThumb: z.boolean(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  startedAt: z.number().nullable(),
})
export type VideoView = z.infer<typeof videoViewSchema>

export const channelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  niche: z.string(),
  language: z.enum(LANGUAGES),
  ttsProvider: z.enum(['elevenlabs', 'openai', 'azure']).nullable(),
  voiceId: z.string().nullable(),
  musicMood: z.enum(MUSIC_MOODS).nullable(),
  stylePreset: stylePresetSchema,
  videoCount: z.number().int(),
})
export type ChannelSummary = z.infer<typeof channelSummarySchema>

export const licenseEntrySchema = z.object({
  kind: z.enum(['image', 'music']),
  assetId: z.string(),
  scenes: z.array(z.number()),
  source: z.string(),
  author: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  license: z.string().nullable(),
  requiresCredit: z.boolean(),
  creditText: z.string().nullable(),
  status: z.enum(['ok', 'missing_license', 'missing_credit']),
})
export type LicenseEntryView = z.infer<typeof licenseEntrySchema>

export const libraryImageSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  source: z.string(),
  license: z.string().nullable(),
  author: z.string().nullable(),
  creditText: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  usedCount: z.number(),
})

export const quotaSchema = z.object({
  planId: z.enum(PLAN_IDS),
  planName: z.string(),
  month: z.string(),
  videosUsed: z.number(),
  videosPending: z.number(),
  videosLimit: z.number().nullable(),
  videosRemaining: z.number().nullable(),
  cutsUsed: z.number(),
  cutsLimit: z.number().nullable(),
  cutsRemaining: z.number().nullable(),
})
export type QuotaView = z.infer<typeof quotaSchema>

/** Configurações editáveis pela tela (seção 11.6). Chaves nunca voltam ao renderer: só quais existem. */
export const settingsSchema = z.object({
  configuredKeys: z.array(secretIdSchema),
  llmOrder: z.array(z.enum(['anthropic', 'openai', 'gemini'])).min(1),
  ttsOrder: z.array(z.enum(['elevenlabs', 'openai', 'azure'])).min(1),
  imagesOrder: z.array(z.enum(['pexels', 'pixabay'])).min(1),
  imageGeneration: z.boolean(),
  embeddings: z.enum(['clip', 'openai']),
  anthropicModel: z.string().min(1),
  anthropicEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  openaiLlmModel: z.string().min(1),
  openaiTtsModel: z.string().min(1),
  geminiModel: z.string().min(1),
  elevenlabsModel: z.string().min(1),
  azureRegion: z.string().regex(/^[a-z0-9]*$/),
  outputDir: z.string().min(1),
  libraryDir: z.string(),
  concurrency: z.number().int().min(1).max(8),
  planId: z.enum(PLAN_IDS),
})
export type SettingsView = z.infer<typeof settingsSchema>

const scriptActSchema = z.object({ n: z.number().int(), heading: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(5000) })
export const scriptForEditSchema = z.object({
  acts: z.array(scriptActSchema),
  issues: z.array(z.object({ kind: z.string(), act: z.number().nullable(), note: z.string() })),
  targetWords: z.number(),
  wordCount: z.number(),
  editable: z.boolean(),
})
export type ScriptForEdit = z.infer<typeof scriptForEditSchema>

export const estimateSchema = z.object({
  totalCents: z.number(),
  breakdown: z.array(z.object({ stage: z.string(), provider: z.string().nullable(), cents: z.number() })),
  missing: z.array(z.string()),
})

export const runnerStatusSchema = z.object({
  state: z.enum(['starting', 'running', 'restarting', 'stopped']),
  restarts: z.number().int(),
  message: z.string().nullable(),
})
export type RunnerStatus = z.infer<typeof runnerStatusSchema>

const idInput = z.object({ id: z.uuid() })
const okOutput = z.object({ ok: z.boolean(), message: z.string().optional() })

/**
 * Contrato de IPC: cada canal tem schema de entrada e saída. O preload valida
 * antes de enviar e o main valida de novo ao receber (o main não confia no renderer).
 */
export const ipcContract = {
  'channels:list': { input: z.undefined(), output: z.array(channelSummarySchema) },
  'videos:list': { input: z.object({ onlyDone: z.boolean() }), output: z.array(videoViewSchema) },
  'videos:estimate': { input: videoRequestSchema, output: estimateSchema },
  'videos:create': { input: videoRequestSchema, output: z.object({ videoId: z.string(), jobId: z.string() }) },
  'videos:cancel': { input: idInput, output: okOutput },
  'videos:resume': { input: idInput, output: okOutput },
  'videos:getScript': { input: idInput, output: scriptForEditSchema },
  'videos:saveScript': { input: z.object({ id: z.uuid(), acts: z.array(scriptActSchema).min(5).max(7) }), output: scriptForEditSchema },
  'videos:delete': { input: idInput, output: okOutput },
  'videos:openFolder': { input: idInput, output: okOutput },
  'videos:copy': { input: z.object({ id: z.uuid(), field: z.enum(['title', 'description']) }), output: okOutput },
  'channels:save': { input: z.object({ id: z.uuid().nullable(), channel: channelInputSchema }), output: channelSummarySchema },
  'channels:remove': { input: idInput, output: z.object({ ok: z.boolean(), result: z.enum(['deleted', 'archived']) }) },
  'channels:previewVoice': {
    input: z.object({ language: z.enum(LANGUAGES), ttsProvider: z.enum(['elevenlabs', 'openai', 'azure']).nullable(), voiceId: z.string().nullable() }),
    output: z.object({ provider: z.string(), dataUrl: z.string() }),
  },
  'licenses:videos': { input: z.undefined(), output: z.array(z.object({ id: z.string(), title: z.string().nullable(), theme: z.string(), state: z.string(), createdAt: z.number() })) },
  'licenses:forVideo': { input: idInput, output: z.array(licenseEntrySchema) },
  'licenses:exportCsv': { input: z.object({ ids: z.array(z.uuid()).min(1) }), output: z.object({ ok: z.boolean(), path: z.string().nullable(), rows: z.number() }) },
  'licenses:setCredit': { input: z.object({ imageId: z.uuid(), credit: z.string().trim().min(1).max(300) }), output: okOutput },
  'images:list': { input: z.object({ quarantine: z.boolean() }), output: z.array(libraryImageSchema) },
  'images:setLicense': {
    input: z.object({ id: z.uuid(), license: z.enum(['cc0', 'public_domain', 'own']).nullable(), credit: z.string().trim().max(300).nullable() }),
    output: okOutput,
  },
  'images:import': {
    input: z.object({ license: z.enum(['cc0', 'public_domain', 'own']).nullable(), credit: z.string().trim().max(300).nullable() }),
    output: z.object({ ok: z.boolean(), imported: z.number(), updated: z.number(), rejected: z.number(), quarantined: z.number(), message: z.string().nullable() }),
  },
  'settings:get': { input: z.undefined(), output: settingsSchema },
  'settings:save': { input: settingsSchema.omit({ configuredKeys: true }).partial(), output: settingsSchema },
  'settings:chooseFolder': { input: z.object({ purpose: z.enum(['output', 'library']) }), output: z.object({ path: z.string().nullable() }) },
  'keys:set': { input: z.object({ id: secretIdSchema, value: z.string().trim().min(8).max(4096) }), output: okOutput },
  'keys:delete': { input: z.object({ id: secretIdSchema }), output: okOutput },
  'keys:test': { input: z.object({ id: secretIdSchema }), output: z.object({ ok: z.boolean(), message: z.string(), latencyMs: z.number() }) },
  'quota:status': { input: z.undefined(), output: quotaSchema },
  'app:legal': { input: z.object({ doc: z.enum(['terms', 'privacy', 'third-party']) }), output: z.object({ title: z.string(), text: z.string() }) },
  'runner:status': { input: z.undefined(), output: runnerStatusSchema },
  'app:info': {
    input: z.undefined(),
    output: z.object({ version: z.string(), dataDir: z.string(), platform: z.string() }),
  },
  'app:openLogs': { input: z.undefined(), output: okOutput },
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>

/** Eventos main → renderer. */
export const ipcEvents = {
  'jobs:changed': z.object({ jobId: z.string().nullable() }),
  'runner:status': runnerStatusSchema,
  'images:importProgress': z.object({ done: z.number(), file: z.string(), status: z.string(), reason: z.string().nullable() }),
} as const
export type IpcEvent = keyof typeof ipcEvents
export type IpcEventPayload<E extends IpcEvent> = z.output<(typeof ipcEvents)[E]>

/** Erro serializável devolvido pelo main: mensagem acionável, sem stack. */
export const ipcErrorSchema = z.object({ __ipcError: z.literal(true), message: z.string() })

export interface MudoBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcInput<C> extends undefined ? [] : [IpcInput<C>]): Promise<IpcOutput<C>>
  on<E extends IpcEvent>(event: E, cb: (payload: IpcEventPayload<E>) => void): () => void
}
