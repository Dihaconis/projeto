import type { JobHandlers } from './context'
import { cutExportHandler, cutHandler } from './cut'
import { videoHandler } from './video'

/** Handlers por tipo de job. */
export const jobHandlers: JobHandlers = {
  video: videoHandler,
  cut: cutHandler,
  cut_export: cutExportHandler,
}
