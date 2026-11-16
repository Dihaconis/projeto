import fs from 'node:fs'
import path from 'node:path'

/** Layout de `%APPDATA%/MUDO` (seção 4 e 15). Nunca dentro de Program Files. */
export interface DataPaths {
  root: string
  db: string
  work: string
  logs: string
  backups: string
  config: string
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    db: path.join(root, 'mudo.db'),
    work: path.join(root, 'work'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    config: path.join(root, 'config.json'),
  }
}

/**
 * Pasta de dados padrão sem depender do Electron (usada também pela CLI).
 * `MUDO_DATA_DIR` sobrescreve (testes e instalações portáteis).
 */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUDO_DATA_DIR) return path.resolve(env.MUDO_DATA_DIR)
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'MUDO')
  if (process.platform === 'darwin' && env.HOME)
    return path.join(env.HOME, 'Library', 'Application Support', 'MUDO')
  const base = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? '.', '.config')
  return path.join(base, 'MUDO')
}

export function ensureDataDirs(p: DataPaths): void {
  for (const dir of [p.root, p.work, p.logs, p.backups]) fs.mkdirSync(dir, { recursive: true })
}

/** Pasta de trabalho de um job: artefatos persistentes + `tmp/` descartável. */
export function jobWorkDir(p: DataPaths, key: string): { dir: string; tmp: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`chave de pasta de trabalho inválida: ${key}`)
  const dir = path.join(p.work, key)
  return { dir, tmp: path.join(dir, 'tmp') }
}

/** Escrita atômica: grava em arquivo temporário vizinho e renomeia. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.part`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
