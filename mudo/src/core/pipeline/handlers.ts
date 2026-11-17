import type { JobHandlers } from './context'
import { videoHandler } from './video'

/** Handlers por tipo de job. */
export const jobHandlers: JobHandlers = {
  video: videoHandler,
}
