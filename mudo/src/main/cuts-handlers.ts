import { dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import type { Logger } from 'pino'
import { JobError, JobQueue, createCutJob, cutJobOf, deleteCut, enqueueCutExport, getCutDetail, listCutViews, type DataPaths, type DbHandle } from '../core'
import { UserFacingError, type IpcHandlers } from './ipc'
import type { RunnerHost } from './runner-host'

interface Ctx {
  handle: DbHandle
  paths: DataPaths
  log: Logger
  runner: RunnerHost
  window: () => BrowserWindow | null
  broadcast: (channel: string, payload: unknown) => void
}

const userError = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (err) {
    if (err instanceof JobError && (err.code === 'INVALID_INPUT' || err.code === 'QUOTA_EXCEEDED')) throw new UserFacingError(err.message)
    throw err
  }
}

type CutsHandlers = Pick<IpcHandlers, 'cuts:list' | 'cuts:chooseFile' | 'cuts:create' | 'cuts:detail' | 'cuts:export' | 'cuts:showFile' | 'cuts:retry' | 'cuts:delete'>

/** Cortes (Beta, seção 11.3): análise e exportação rodam no runner. */
export function cutsHandlers(c: Ctx): CutsHandlers {
  const h = c.handle
  const kick = (jobId: string | null) => {
    c.runner.send({ type: 'poke' })
    c.broadcast('jobs:changed', { jobId })
  }
  return {
    'cuts:list': () => listCutViews(h),
    'cuts:chooseFile': async () => {
      const w = c.window()
      const opts = { title: 'Vídeo para cortar', properties: ['openFile' as const], filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return { path: r.canceled ? null : (r.filePaths[0] ?? null) }
    },
    'cuts:create': ({ source, authorized }) => {
      const { cut, job } = userError(() => createCutJob(h, { source, authorized }))
      c.log.info({ cutId: cut.id, sourceType: cut.sourceType }, 'corte enfileirado (autorização confirmada pelo usuário)')
      kick(job.id)
      return { cutId: cut.id }
    },
    'cuts:detail': ({ id }) => userError(() => getCutDetail(h, id)),
    'cuts:export': ({ highlightId }) => {
      const job = userError(() => enqueueCutExport(h, highlightId))
      c.log.info({ highlightId, jobId: job.id }, 'exportação de corte enfileirada')
      kick(job.id)
      return { ok: true }
    },
    'cuts:showFile': ({ highlightId }) => {
      const hl = getCutDetail(h, (h.sqlite.prepare('SELECT cut_id FROM cut_highlights WHERE id = ?').get(highlightId) as { cut_id: string } | undefined)?.cut_id ?? '').highlights.find(
        (x) => x.id === highlightId,
      )
      if (!hl?.exportedPath || !fs.existsSync(hl.exportedPath)) return { ok: false, message: 'O arquivo do corte não está mais na pasta.' }
      shell.showItemInFolder(hl.exportedPath)
      return { ok: true }
    },
    'cuts:retry': ({ id }) => {
      const j = cutJobOf(h, id)
      if (!j) throw new UserFacingError('Corte não encontrado.')
      const r = new JobQueue(h).resume(j.id)
      if (!r.ok) return { ok: false, message: 'Só é possível tentar de novo uma análise com falha, cancelada ou aguardando você.' }
      kick(j.id)
      return { ok: true }
    },
    'cuts:delete': ({ id }) => {
      userError(() => deleteCut(h, c.paths, id))
      c.broadcast('jobs:changed', { jobId: null })
      return { ok: true }
    },
  }
}
