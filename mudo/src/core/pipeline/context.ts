import type { Logger } from 'pino'
import type { DbHandle } from '../db'
import type { MediaBinaries } from '../media/ffmpeg'
import type { ProviderSource } from '../providers/registry'
import type { JobKind, Stage } from '../../shared/enums'
import type { DataPaths } from '../paths'
import type { SpawnOptions, SpawnResult } from '../proc/spawn'
import type { JobRow } from '../queue/queue'

export type SharedResource = 'assemble'

export interface JobContext {
  readonly job: JobRow
  readonly signal: AbortSignal
  readonly paths: DataPaths
  readonly workDir: string
  readonly tmpDir: string
  readonly log: Logger
  readonly db: DbHandle
  readonly providers: ProviderSource
  readonly media: MediaBinaries
  /** Entra numa etapa; o tempo gasto nela vai para `stage_timings`. */
  enterStage(stage: Stage): void
  /** Progresso dentro da etapa atual, 0–1. */
  stageProgress(fraction: number): void
  checkpoint<T>(): T
  saveCheckpoint(cp: unknown): void
  /** Tempo acumulado por etapa até agora (inclui a etapa em curso). */
  elapsedMs(): number
  /** Soma custo (centavos) ao job e ao vídeo. */
  addCost(cents: number): void
  /** Recurso limitado entre jobs do mesmo runner (ex.: montagem 1 por vez). */
  acquire(resource: SharedResource): Promise<() => void>
  /** Processo filho registrado no banco e morto junto com o job. */
  spawn(command: string, args: readonly string[], opts?: Omit<SpawnOptions, 'signal' | 'onStart' | 'onExit'>): Promise<SpawnResult>
}

export type JobHandler = (ctx: JobContext) => Promise<void>
export type JobHandlers = Record<JobKind, JobHandler>

/** Peso de cada etapa no progresso total. */
export const STAGE_WEIGHTS: Record<Stage, number> = {
  script: 0.1,
  review: 0.05,
  images: 0.25,
  tts: 0.25,
  assemble: 0.35,
}
