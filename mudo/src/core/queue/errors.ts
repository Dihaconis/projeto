import { z } from 'zod'
import { ERROR_CODES, type ErrorCode } from '../../shared/enums'

export const jobErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
})
export type JobErrorInfo = z.infer<typeof jobErrorSchema>

/** Erro de etapa. `retryable` = falha técnica que pode dar certo noutra tentativa. */
export class JobError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'JobError'
  }
  toInfo(): JobErrorInfo {
    return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) }
  }
}

/** A etapa precisa de decisão do usuário: o job vai para `needs_input`. */
export class NeedsInputError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'NeedsInputError'
  }
  toInfo(): JobErrorInfo {
    return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) }
  }
}

export function toErrorInfo(err: unknown): JobErrorInfo {
  if (err instanceof JobError || err instanceof NeedsInputError) return err.toInfo()
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'INTERNAL', message }
}
