import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { Logger } from 'pino'
import type { RunnerStatus } from '../shared/ipc'
import { fromRunnerSchema, toRunnerSchema, type FromRunner, type ToRunner } from '../shared/runner-protocol'

export interface RunnerHostOptions {
  dataDir: string
  concurrency: number
  orphanAfterMs: number
  log: Logger
  onMessage: (m: FromRunner) => void
  onStatus: (s: RunnerStatus) => void
}

/**
 * Mantém o runner (utilityProcess) vivo: inicia, reinicia com backoff se cair
 * e encerra de forma limpa (devolvendo jobs à fila) quando o app fecha.
 */
export class RunnerHost {
  private child: UtilityProcess | null = null
  private status: RunnerStatus = { state: 'stopped', restarts: 0, message: null }
  private quitting = false
  private restartTimer: NodeJS.Timeout | null = null
  private healthyTimer: NodeJS.Timeout | null = null
  private consecutiveCrashes = 0

  constructor(private readonly o: RunnerHostOptions) {}

  getStatus(): RunnerStatus {
    return this.status
  }

  start(): void {
    this.setStatus({ ...this.status, state: 'starting', message: null })
    const child = utilityProcess.fork(path.join(__dirname, 'runner.js'), [], {
      serviceName: 'MUDO Runner',
      stdio: 'inherit',
    })
    this.child = child
    child.on('message', (data: unknown) => {
      const parsed = fromRunnerSchema.safeParse(data)
      if (!parsed.success) {
        this.o.log.warn('mensagem inválida do runner descartada')
        return
      }
      const m = parsed.data
      if (m.type === 'ready') {
        this.setStatus({ ...this.status, state: 'running', message: null })
        this.healthyTimer = setTimeout(() => (this.consecutiveCrashes = 0), 60_000)
      } else if (m.type === 'fatal') {
        this.o.log.error({ message: m.message }, 'runner reportou erro fatal')
        this.setStatus({ ...this.status, message: m.message })
      }
      this.o.onMessage(m)
    })
    child.on('exit', (code) => {
      if (this.healthyTimer) clearTimeout(this.healthyTimer)
      this.child = null
      if (this.quitting) {
        this.setStatus({ ...this.status, state: 'stopped' })
        return
      }
      this.consecutiveCrashes++
      const delay = Math.min(30_000, 1000 * 2 ** (this.consecutiveCrashes - 1))
      this.o.log.error({ code, delay }, 'runner encerrou inesperadamente; reiniciando')
      this.setStatus({
        state: 'restarting',
        restarts: this.status.restarts + 1,
        message: `O processo de geração parou (código ${code}). Reiniciando em ${Math.round(delay / 1000)} s.`,
      })
      this.restartTimer = setTimeout(() => this.start(), delay)
    })
    this.send({
      type: 'init',
      dataDir: this.o.dataDir,
      concurrency: this.o.concurrency,
      orphanAfterMs: this.o.orphanAfterMs,
    })
  }

  send(m: ToRunner): void {
    this.child?.postMessage(toRunnerSchema.parse(m))
  }

  /** Pede desligamento limpo; mata se não responder a tempo. */
  async stop(timeoutMs = 4000): Promise<void> {
    this.quitting = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill()
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      this.send({ type: 'shutdown' })
    })
  }

  private setStatus(s: RunnerStatus): void {
    this.status = s
    this.o.onStatus(s)
  }
}
