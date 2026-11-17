import { z } from 'zod'
import { secretIdSchema } from '../core/secrets'

/** Mensagens main → runner (utilityProcess). */
export const toRunnerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    dataDir: z.string(),
    binDir: z.string().nullable(),
    modelsDir: z.string(),
    concurrency: z.number().int().min(1).max(8),
    orphanAfterMs: z.number().int().min(500),
  }),
  z.object({ type: z.literal('poke') }),
  /** Conferir a posse de um job agora (cancelamento imediato). */
  z.object({ type: z.literal('check'), jobId: z.string() }),
  z.object({ type: z.literal('setConcurrency'), concurrency: z.number().int().min(1).max(8) }),
  z.object({ type: z.literal('shutdown') }),
  /** Importar imagens para o acervo (CLIP roda aqui, nunca no main). */
  z.object({
    type: z.literal('import-images'),
    reqId: z.number().int(),
    target: z.string(),
    license: z.enum(['cc0', 'public_domain', 'own']).nullable(),
    credit: z.string().nullable(),
    author: z.string().nullable(),
  }),
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
  z.object({ type: z.literal('import-progress'), reqId: z.number().int(), done: z.number().int(), file: z.string(), status: z.string(), reason: z.string().nullable() }),
  z.object({
    type: z.literal('import-done'),
    reqId: z.number().int(),
    imported: z.number().int(),
    updated: z.number().int(),
    rejected: z.number().int(),
    quarantined: z.number().int(),
    error: z.string().nullable(),
  }),
])
export type FromRunner = z.infer<typeof fromRunnerSchema>
