import fs from 'node:fs'
/**
 * Entrada do `utilityProcess`: consome a fila fora do main e do renderer.
 * Conversa com o main só por mensagens validadas por zod.
 */
import {
  Runner,
  configuredProviders,
  createLogger,
  dataPaths,
  ensureDataDirs,
  jobHandlers,
  openDatabase,
  resolveMediaBinaries,
  type DbHandle,
  type SecretId,
  type SecretStore,
} from '../core'
import { importFolder, importImageFile, type ImportResult, type LibraryLicense } from '../core/images/library'
import { fromRunnerSchema, toRunnerSchema, type FromRunner } from '../shared/runner-protocol'

const port = process.parentPort
if (!port) throw new Error('runner deve ser iniciado como utilityProcess')

const send = (m: FromRunner) => port.postMessage(fromRunnerSchema.parse(m))

let runner: Runner | null = null
let handle: DbHandle | null = null

/** Chaves pedidas ao main sob demanda; ficam só na memória deste processo. */
let nextReq = 1
const pendingSecrets = new Map<number, (v: string | null) => void>()
const remoteSecrets: SecretStore = {
  get: (id: SecretId) =>
    new Promise<string | null>((resolve) => {
      const reqId = nextReq++
      const t = setTimeout(() => {
        pendingSecrets.delete(reqId)
        resolve(null)
      }, 10_000)
      pendingSecrets.set(reqId, (v) => {
        clearTimeout(t)
        resolve(v)
      })
      send({ type: 'get-secret', reqId, id })
    }),
}

port.on('message', (e: Electron.MessageEvent) => {
  const parsed = toRunnerSchema.safeParse(e.data)
  if (!parsed.success) return
  const msg = parsed.data
  switch (msg.type) {
    case 'secret': {
      const cb = pendingSecrets.get(msg.reqId)
      pendingSecrets.delete(msg.reqId)
      cb?.(msg.value)
      break
    }
    case 'import-images':
      void importImages(msg.reqId, msg.target, msg.license, msg.credit, msg.author)
      break
    case 'init':
      void init(msg.dataDir, msg.binDir, msg.modelsDir, msg.concurrency, msg.orphanAfterMs).catch((err: unknown) => {
        send({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })
        process.exit(1)
      })
      break
    case 'poke':
      runner?.poke()
      break
    case 'check':
      runner?.checkLease(msg.jobId)
      break
    case 'setConcurrency':
      runner?.setConcurrency(msg.concurrency)
      break
    case 'shutdown':
      void (async () => {
        await runner?.stop()
        handle?.close()
        send({ type: 'stopped' })
        process.exit(0)
      })()
      break
  }
})

async function init(dataDir: string, binDir: string | null, modelsDir: string, concurrency: number, orphanAfterMs: number): Promise<void> {
  if (runner) return
  const paths = dataPaths(dataDir)
  ensureDataDirs(paths)
  const log = await createLogger(paths.logs, 'runner')
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'exceção não tratada no runner')
    send({ type: 'fatal', message: err.message })
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => log.error({ err }, 'promise rejeitada sem tratamento'))

  handle = openDatabase(paths.db)
  runner = new Runner({
    handle,
    paths,
    log,
    handlers: jobHandlers,
    providers: (providersForImport = configuredProviders(handle, remoteSecrets, { modelsDir })),
    media: resolveMediaBinaries({ binDir: binDir ?? undefined }),
    concurrency,
    orphanAfterMs,
    onChange: (jobId) => send({ type: 'job-changed', jobId }),
  })
  runner.start()
  log.info({ runnerId: runner.id, concurrency, orphanAfterMs }, 'runner iniciado')
  send({ type: 'ready', runnerId: runner.id })
}

let providersForImport: ReturnType<typeof configuredProviders> | null = null

/** Importação do acervo pedida pela interface: pHash + CLIP aqui, progresso por mensagem. */
async function importImages(reqId: number, target: string, license: LibraryLicense | null, credit: string | null, author: string | null): Promise<void> {
  const result = { imported: 0, updated: 0, rejected: 0, quarantined: 0 }
  try {
    if (!handle || !providersForImport) throw new Error('runner ainda não iniciado')
    const emb = await providersForImport.embeddings()
    let done = 0
    const onFile = (r: ImportResult) => {
      done++
      if (r.status === 'imported') result.imported++
      else if (r.status === 'updated') result.updated++
      else result.rejected++
      if (r.status !== 'rejected' && r.quarantined) result.quarantined++
      send({ type: 'import-progress', reqId, done, file: r.file, status: r.status, reason: r.reason ?? null })
    }
    const opts = { license, credit, author }
    if (fs.statSync(target).isDirectory()) await importFolder(handle, emb, target, opts, onFile)
    else onFile(await importImageFile(handle, emb, target, opts))
    send({ type: 'import-done', reqId, ...result, error: null })
  } catch (err) {
    send({ type: 'import-done', reqId, ...result, error: err instanceof Error ? err.message : String(err) })
  }
}
