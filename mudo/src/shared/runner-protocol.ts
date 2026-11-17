import { z } from 'zod'
import { secretIdSchema } from '../core/secrets'

/** Mensagens main → runner (utilityProcess). */
export const toRunnerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    dataDir: z.string(),
    binDir: z.string().nullable(),
    concurrency: z.number().int().min(1).max(8),
    orphanAfterMs: z.number().int().min(500),
  }),
  z.object({ type: z.literal('poke') }),
  /** Conferir a posse de um job agora (cancelamento imediato). */
  z.object({ type: z.literal('check'), jobId: z.string() }),
  z.object({ type: z.literal('setConcurrency'), concurrency: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal('shutdown') }),
  /** Resposta a `get-secret`. O valor nunca é logado. */
  z.object({ type: z.literal('secret'), reqId: z.number().int(), value: z.string().nullable() }),
])
export type ToRunner = z.infer<typeof toRunnerSchema>

/** Mensagens runner → main. */
export const fromRunnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), runnerId: z.string() }),
  z.object({ type: z.literal('job-changed'), jobId: z.string() }),
  z.object({ type: z.literal('stopped') }),
  z.object({ type: z.literal('fatal'), message: z.string() }),
  z.object({ type: z.literal('get-secret'), reqId: z.number().int(), id: secretIdSchema }),
])
export type FromRunner = z.infer<typeof fromRunnerSchema>
