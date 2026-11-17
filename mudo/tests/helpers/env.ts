import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataPaths, ensureDataDirs, migrateDatabase, openDatabase, setSetting, type DataPaths, type DbHandle } from '../../src/core'

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')

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
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000, stepMs = 25): Promise<T> {
  const start = Date.now()
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
