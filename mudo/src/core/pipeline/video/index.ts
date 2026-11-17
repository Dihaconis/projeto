import fs from 'node:fs'
import type { JobHandler } from '../context'
import { assembleStage } from './assemble-stage'
import { imagesStage } from './images-stage'
import { reviewStage, scriptStage } from './script-stage'
import { loadVideoJob, refreshVideo } from './state'
import { ttsStage } from './tts-stage'

/**
 * Pipeline do vídeo, sempre nesta ordem (seção 1):
 * roteiro → revisão → imagens → narração → montagem → pronto.
 * Cada etapa confere o próprio checkpoint e pula o que já existe.
 */
export const videoHandler: JobHandler = async (ctx) => {
  const st = loadVideoJob(ctx)
  await scriptStage(st)
  await reviewStage(st)
  refreshVideo(st)
  await imagesStage(st)
  await ttsStage(st)
  await assembleStage(st)
  // temporários só fazem sentido durante o job
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
}
