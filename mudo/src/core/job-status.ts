import type { JobState } from '../shared/enums'
import type { DbHandle } from './db'
import { jobErrorSchema } from './queue/errors'
import type { JobRow } from './queue/queue'
import { getVideo } from './videos'

/** Estado de um job no formato estável da CLI (`--json`) e do MCP. */
export interface JobStatusJson {
  jobId: string
  videoId: string | null
  state: JobState
  stage: string | null
  progress: number
  attempt: number
  error: { code: string; message: string } | null
  title: string | null
  outputPath: string | null
  costCents: number
  genTimeS: number | null
  actualDurationS: number | null
}

export function statusJson(h: DbHandle, j: JobRow): JobStatusJson {
  const v = j.videoId ? getVideo(h, j.videoId) : undefined
  const e = jobErrorSchema.safeParse(j.lastError)
  return {
    jobId: j.id,
    videoId: j.videoId,
    state: j.state,
    stage: j.stage,
    progress: Math.round(j.progress * 1000) / 1000,
    attempt: j.attempt,
    error: e.success ? { code: e.data.code, message: e.data.message } : null,
    title: v?.title ?? null,
    outputPath: v?.outputPath ?? null,
    costCents: Math.round(j.costCents * 100) / 100,
    genTimeS: v?.genTimeS ?? null,
    actualDurationS: v?.actualDurationS ?? null,
  }
}

