import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { DEFAULTS, type AnyStage } from '../../shared/enums'
import type { DbHandle } from '../db'
import type { MediaBinaries } from '../media/ffmpeg'
import type { ProviderSource } from '../providers/registry'
import { jobWorkDir, type DataPaths } from '../paths'
import { STAGE_PLAN, type JobContext, type JobHandlers, type SharedResource } from '../pipeline/context'
import { commandName, isSameProcessAlive, killPidTree, runProcess } from '../proc/spawn'
import { JobError, NeedsInputError, toErrorInfo } from '../queue/errors'
import { JobQueue, type JobRow, type StageTimings } from '../queue/queue'
import { Semaphore } from './semaphore'

export interface RunnerOptions {
  handle: DbHandle
  paths: DataPaths
  log: Logger
  handlers: JobHandlers
  providers: ProviderSource
  media: MediaBinaries
  concurrency?: number
  assembleConcurrency?: number
  orphanAfterMs?: number
  heartbeatMs?: number
  reaperIntervalMs?: number
  pollMs?: number
  /** Se definido, o runner só pega estes jobs (CLI `--wait`). */
  onlyJobIds?: ReadonlySet<string>
  /** Notificado a cada mudança relevante de um job (para a UI). */
  onChange?: (jobId: string) => void
}

const SHUTDOWN = 'runner-shutdown'
const LEASE_LOST = 'lease-lost'

/** Pasta de trabalho do job: por vídeo, ou pelo id do job quando não há vídeo. */
export function workKey(job: Pick<JobRow, 'id' | 'videoId'> & { payload?: unknown }): string {
  const cutId = (job.payload as { cutId?: unknown } | undefined)?.cutId
  return job.videoId ?? (typeof cutId === 'string' && /^[0-9a-f-]{36}$/.test(cutId) ? cutId : job.id)
}

/** Remove os temporários do job (usado no cancelamento). Checkpoints ficam. */
export function cleanupJobTemp(paths: DataPaths, job: Pick<JobRow, 'id' | 'videoId'>): void {
  const { tmp } = jobWorkDir(paths, workKey(job))
  fs.rmSync(tmp, { recursive: true, force: true })
}

/** Mata processos filhos registrados de um job, conferindo o executável. */
export function killRegisteredProcs(queue: JobQueue, jobId: string, log?: Logger): number {
  let killed = 0
  for (const p of queue.listProcs(jobId)) {
    if (isSameProcessAlive(p.pid, p.command)) {
      killPidTree(p.pid)
      killed++
      log?.warn({ jobId, pid: p.pid, command: commandName(p.command) }, 'processo filho remanescente encerrado')
    }
  }
  queue.clearProcs(jobId)
  return killed
}

/**
 * Consome a fila. Roda dentro do `utilityProcess` no app e direto no processo
 * da CLI. Vários runners podem coexistir: a posse é garantida pelo banco.
 */
export class Runner {
  readonly id = `runner-${process.pid}-${randomUUID().slice(0, 8)}`
  readonly queue: JobQueue
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly resources: Record<SharedResource, Semaphore>
  private pollTimer: NodeJS.Timeout | null = null
  private reaperTimer: NodeJS.Timeout | null = null
  private stopping = false
  private ticking = false
  private concurrency: number
  private readonly o: Required<Omit<RunnerOptions, 'onChange' | 'concurrency' | 'onlyJobIds'>> & Pick<RunnerOptions, 'onChange' | 'onlyJobIds'>

  constructor(opts: RunnerOptions) {
    this.o = {
      assembleConcurrency: DEFAULTS.assembleConcurrency,
      orphanAfterMs: DEFAULTS.orphanAfterMs,
      heartbeatMs: DEFAULTS.heartbeatMs,
      reaperIntervalMs: DEFAULTS.reaperIntervalMs,
      pollMs: 500,
      ...opts,
    }
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency)
    this.queue = new JobQueue(opts.handle)
    this.resources = { assemble: new Semaphore(Math.max(1, this.o.assembleConcurrency)) }
  }

  get activeJobIds(): string[] {
    return [...this.active.keys()]
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.floor(n))
    this.poke()
  }

  start(): void {
    this.reap()
    this.pollTimer = setInterval(() => this.poke(), this.o.pollMs)
    this.reaperTimer = setInterval(() => this.reap(), this.o.reaperIntervalMs)
    this.poke()
  }

  /** Para de pegar jobs, interrompe os ativos e os devolve à fila sem gastar tentativa. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.reaperTimer) clearInterval(this.reaperTimer)
    for (const { controller } of this.active.values()) controller.abort(SHUTDOWN)
    await Promise.allSettled([...this.active.values()].map((a) => a.done))
  }

  /** Confere a posse de um job ativo agora (ex.: logo após cancelamento). */
  checkLease(jobId: string): void {
    const a = this.active.get(jobId)
    if (a && !this.queue.heartbeat(jobId, this.id)) a.controller.abort(LEASE_LOST)
  }

  /** Recupera órfãos: mata filhos remanescentes e devolve à fila do checkpoint. */
  reap(): void {
    try {
      for (const job of this.queue.findOrphans(this.o.orphanAfterMs)) {
        if (this.active.has(job.id)) continue
        killRegisteredProcs(this.queue, job.id, this.o.log)
        const r = this.queue.recoverOrphan(job.id, this.o.orphanAfterMs)
        if (r !== 'skipped') {
          this.o.log.warn({ jobId: job.id, result: r, attempt: job.attempt }, 'job órfão recuperado')
          this.o.onChange?.(job.id)
        }
      }
      for (const p of this.queue.strayProcs()) {
        if (isSameProcessAlive(p.pid, p.command)) killPidTree(p.pid)
        this.queue.removeProc(p.jobId, p.pid)
      }
    } catch (err) {
      this.o.log.error({ err }, 'falha ao recuperar órfãos')
    }
  }

  /** Tenta pegar jobs até preencher o pool. */
  poke(): void {
    if (this.stopping || this.ticking) return
    this.ticking = true
    try {
      while (!this.stopping && this.active.size < this.concurrency) {
        let job: JobRow | null = null
        if (this.o.onlyJobIds) {
          for (const id of this.o.onlyJobIds) {
            if (this.active.has(id)) continue
            job = this.queue.claim(this.id, id)
            if (job) break
          }
        } else job = this.queue.claim(this.id)
        if (!job) break
        this.launch(job)
      }
    } catch (err) {
      this.o.log.error({ err }, 'falha ao reivindicar job')
    } finally {
      this.ticking = false
    }
  }

  private launch(job: JobRow): void {
    const controller = new AbortController()
    const done = this.execute(job, controller).finally(() => {
      this.active.delete(job.id)
      this.o.onChange?.(job.id)
      setImmediate(() => this.poke())
    })
    this.active.set(job.id, { controller, done })
    this.o.onChange?.(job.id)
  }

  private async execute(job: JobRow, controller: AbortController): Promise<void> {
    const { log, paths } = this.o
    const jlog = log.child({ jobId: job.id, kind: job.kind, attempt: job.attempt })
    const { dir, tmp } = jobWorkDir(paths, workKey(job))
    fs.mkdirSync(dir, { recursive: true })

    const signal = controller.signal
    const hb = setInterval(() => {
      if (!this.queue.heartbeat(job.id, this.id)) controller.abort(LEASE_LOST)
    }, this.o.heartbeatMs)

    let checkpoint: unknown = job.checkpoint
    let costCents = job.costCents
    const timings: StageTimings = { ...((job.stageTimings ?? {}) as StageTimings) }
    let stage: AnyStage | null = null
    let stageStart = 0
    let stageFraction = 0
    let lastEmit = 0

    const flushTiming = () => {
      if (stage) timings[stage] = (timings[stage] ?? 0) + (Date.now() - stageStart)
      stageStart = Date.now()
    }
    const overall = () => {
      if (!stage) return 0
      let p = 0
      for (const [s, w] of STAGE_PLAN[job.kind]) {
        if (s === stage) return p + w * stageFraction
        p += w
      }
      return p
    }
    const write = (patch: Parameters<JobQueue['update']>[2]) => {
      if (!this.queue.update(job.id, this.id, patch)) controller.abort(LEASE_LOST)
    }

    const ctx: JobContext = {
      job,
      signal,
      paths,
      workDir: dir,
      tmpDir: tmp,
      log: jlog,
      db: this.o.handle,
      providers: this.o.providers,
      media: this.o.media,
      enterStage: (s) => {
        flushTiming()
        stage = s
        stageFraction = 0
        write({ stage: s, progress: overall(), stageTimings: timings })
        this.o.onChange?.(job.id)
        jlog.info({ stage: s }, 'etapa iniciada')
      },
      stageProgress: (f) => {
        stageFraction = Math.min(1, Math.max(0, f))
        const t = Date.now()
        if (t - lastEmit < 250 && stageFraction < 1) return
        lastEmit = t
        write({ progress: overall() })
        this.o.onChange?.(job.id)
      },
      checkpoint: <T>() => checkpoint as T,
      saveCheckpoint: (cp) => {
        checkpoint = cp
        write({ checkpoint: cp })
      },
      elapsedMs: () => {
        const done = Object.values(timings).reduce((a, b) => a + (b ?? 0), 0)
        return done + (stage ? Date.now() - stageStart : 0)
      },
      addCost: (cents) => {
        if (!Number.isFinite(cents) || cents <= 0) return
        costCents += cents
        write({ costCents })
      },
      acquire: (resource) => this.resources[resource].acquire(signal),
      spawn: (command, args, opts) =>
        runProcess(command, args, {
          ...opts,
          signal,
          onStart: (pid) => this.queue.addProc(job.id, pid, command),
          onExit: (pid) => this.queue.removeProc(job.id, pid),
        }),
    }

    jlog.info('job iniciado')
    const startedAt = Date.now()
    try {
      if (signal.aborted) throw signal.reason
      const handler = this.o.handlers[job.kind]
      if (!handler) throw new JobError('INTERNAL', `sem handler para jobs do tipo ${job.kind}`)
      await handler(ctx)
      if (signal.aborted) throw signal.reason
      flushTiming()
      write({ stageTimings: timings })
      this.queue.finish(job.id, this.id, { state: 'done' })
      jlog.info({ ms: Date.now() - startedAt, timings }, 'job concluído')
    } catch (err) {
      flushTiming()
      const reason = signal.aborted ? signal.reason : null
      if (reason === SHUTDOWN) {
        this.queue.update(job.id, this.id, { stageTimings: timings })
        this.queue.finish(job.id, this.id, { state: 'queued', countAttempt: false })
        jlog.info('job devolvido à fila (runner encerrando)')
      } else if (reason === LEASE_LOST) {
        const now = this.queue.get(job.id)
        if (now?.state === 'cancelled') {
          cleanupJobTemp(paths, job)
          jlog.info('job cancelado; temporários removidos')
        } else {
          jlog.warn({ state: now?.state }, 'posse do job perdida')
        }
      } else if (err instanceof NeedsInputError) {
        this.queue.update(job.id, this.id, { stageTimings: timings })
        this.queue.finish(job.id, this.id, { state: 'needs_input', error: err.toInfo() })
        jlog.info({ code: err.code }, 'job aguardando ação do usuário')
      } else {
        const info = toErrorInfo(err)
        const retry = err instanceof JobError && err.retryable && job.attempt < job.maxAttempts
        this.queue.update(job.id, this.id, { stageTimings: timings })
        this.queue.finish(
          job.id,
          this.id,
          retry ? { state: 'queued', error: info, countAttempt: true } : { state: 'failed', error: info },
        )
        jlog.error({ err, code: info.code, retry }, retry ? 'falha técnica; nova tentativa' : 'job falhou')
      }
    } finally {
      clearInterval(hb)
      killRegisteredProcs(this.queue, job.id, jlog)
    }
  }
}
