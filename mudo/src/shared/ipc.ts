import { z } from 'zod'
import { videoRequestSchema } from './channel'
import { ERROR_CODES, JOB_STATES, LANGUAGES, STAGES } from './enums'

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
})

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
} as const
export type IpcEvent = keyof typeof ipcEvents
export type IpcEventPayload<E extends IpcEvent> = z.output<(typeof ipcEvents)[E]>

/** Erro serializável devolvido pelo main: mensagem acionável, sem stack. */
export const ipcErrorSchema = z.object({ __ipcError: z.literal(true), message: z.string() })

export interface MudoBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcInput<C> extends undefined ? [] : [IpcInput<C>]): Promise<IpcOutput<C>>
  on<E extends IpcEvent>(event: E, cb: (payload: IpcEventPayload<E>) => void): () => void
}
