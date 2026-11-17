import { z } from 'zod'
import { ERROR_CODES, JOB_KINDS, JOB_STATES, STAGES } from './enums'

/** Visão de job que atravessa a ponte para o renderer (sem payload interno). */
export const jobViewSchema = z.object({
  id: z.string(),
  kind: z.enum(JOB_KINDS),
  state: z.enum(JOB_STATES),
  stage: z.enum(STAGES).nullable(),
  progress: z.number(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).nullable(),
  stageTimings: z.record(z.string(), z.number()),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  title: z.string().nullable(),
  theme: z.string().nullable(),
})
export type JobView = z.infer<typeof jobViewSchema>

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
  'jobs:list': { input: z.undefined(), output: z.array(jobViewSchema) },
  'jobs:cancel': { input: idInput, output: okOutput },
  'jobs:resume': { input: idInput, output: okOutput },
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
