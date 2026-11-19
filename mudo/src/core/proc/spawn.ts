import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  /** Cada linha do stderr (ffmpeg/whisper reportam progresso por aqui). */
  onStderrLine?: (line: string) => void
  onStdoutLine?: (line: string) => void
  /** Chamado assim que o PID existe (para registrar no banco). */
  onStart?: (pid: number) => void
  onExit?: (pid: number) => void
}

export interface SpawnResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

export class ProcessAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super('processo interrompido')
    this.name = 'ProcessAbortedError'
  }
}

/**
 * Executa um binário com argumentos em array — nunca via shell. No POSIX o
 * filho vira líder de grupo para que o grupo inteiro possa ser morto; no
 * Windows a árvore é morta com `taskkill /T /F`.
 */
export function runProcess(command: string, args: readonly string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new ProcessAbortedError(opts.signal.reason))
      return
    }
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let tail = ''
    const lineReader = (cb?: (l: string) => void) => {
      let buf = ''
      return (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        tail = (tail + s).slice(-4000)
        if (!cb) return
        buf += s
        // ffmpeg separa atualizações de progresso com \r
        const parts = buf.split(/\r\n|\n|\r/)
        buf = parts.pop() ?? ''
        for (const p of parts) if (p.length > 0) cb(p)
      }
    }
    child.stdout?.on('data', lineReader(opts.onStdoutLine))
    child.stderr?.on('data', lineReader(opts.onStderrLine))

    const onAbort = () => killTree(child)
    opts.signal.addEventListener('abort', onAbort, { once: true })
    if (child.pid !== undefined) opts.onStart?.(child.pid)

    child.once('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (child.pid !== undefined) opts.onExit?.(child.pid)
      reject(err)
    })
    child.once('close', (code, signal) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (child.pid !== undefined) opts.onExit?.(child.pid)
      if (opts.signal.aborted) reject(new ProcessAbortedError(opts.signal.reason))
      else resolve({ code, signal, stderrTail: tail })
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  killPidTree(child.pid)
}

/** Mata um PID e todos os descendentes. Ignora processo já encerrado. */
export function killPidTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
  } catch {
    // já morreu
  }
}

/** Nome da imagem do executável, para comparar antes de matar PID registrado. */
export function commandName(command: string): string {
  return path.basename(command).toLowerCase().replace(/\.exe$/, '')
}

/**
 * Verifica se `pid` está vivo E roda o mesmo executável registrado — evita
 * matar um processo alheio que reaproveitou o PID depois de um crash.
 */
export function isSameProcessAlive(pid: number, command: string): boolean {
  const expected = commandName(command)
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        encoding: 'utf8',
      })
      const first = r.stdout.split(/\r?\n/)[0] ?? ''
      const m = /^"([^"]+)"/.exec(first)
      return m !== null && commandName(m[1] ?? '') === expected
    }
    process.kill(pid, 0)
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
    const name = r.stdout.trim()
    return name.length > 0 && commandName(name).startsWith(expected.slice(0, 15))
  } catch {
    return false
  }
}
