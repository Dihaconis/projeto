import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataPaths, ensureDataDirs, migrateDatabase, openDatabase, setSetting, type DataPaths, type DbHandle } from '../../src/core'

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

/**
 * Fator de folga para tempos-limite: o runner Windows do CI é bem mais lento
 * em ffmpeg/processos e roda vários arquivos de teste em paralelo.
 */
export const SLOW = Number(process.env.MUDO_TEST_SLOW ?? (process.platform === 'win32' ? 4 : 1))
export const slow = (ms: number): number => ms * SLOW

/** Remove uma pasta temporária; no Windows, arquivos ainda abertos (EBUSY) não derrubam o teste. */
export function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (e) {
    if (process.platform !== 'win32') throw e
  }
}

/** Cópia recursiva explícita (fs.cpSync falha em caminhos com acento no Windows). */
export function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name)
    const b = path.join(dest, e.name)
    if (e.isDirectory()) copyDir(a, b)
    else fs.copyFileSync(a, b)
  }
}

/** Pasta temporária com espaço e acento, como no critério de aceite 8. */
export function tempRoot(prefix = 'mudo teste ação '): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export interface TestEnv {
  paths: DataPaths
  handle: DbHandle
  cleanup(): void
}

export function makeEnv(): TestEnv {
  const root = tempRoot()
  const paths = dataPaths(root)
  ensureDataDirs(paths)
  const handle = openDatabase(paths.db)
  migrateDatabase(handle, { migrationsDir: MIGRATIONS_DIR, backupDir: paths.backups })
  // as fixtures devolvem sempre o mesmo roteiro: a checagem de repetição do canal (seção 10)
  // é testada à parte; aqui fica desligada para gerar vários vídeos no mesmo canal
  setSetting(handle, 'review.maxSimilarity', 1)
  return {
    paths,
    handle,
    cleanup: () => {
      handle.close()
      rmTemp(root)
    },
  }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000, stepMs = 25): Promise<T> {
  const start = Date.now()
  timeoutMs = slow(timeoutMs)
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: tempo esgotado após ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
