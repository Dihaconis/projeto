import type { JobHandlers } from './context'
import { selftestHandler } from './selftest'

/** Handlers por tipo de job. Fase 1: apenas o job de teste. */
export const jobHandlers: JobHandlers = {
  selftest: selftestHandler,
}

export { selftestHandler, selftestPayloadSchema, SELFTEST_STEPS } from './selftest'
