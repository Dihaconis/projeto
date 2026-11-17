import { app, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  JobQueue,
  SETTING_KEYS,
  cleanupJobTemp,
  createLogger,
  dataPaths,
  ensureDataDirs,
  getSetting,
  jobErrorSchema,
  listVideos,
  migrateDatabase,
  openDatabase,
  type JobRow,
} from '../core'
import { DEFAULTS } from '../shared/enums'
import type { JobView, RunnerStatus } from '../shared/ipc'
import { registerIpc, UserFacingError } from './ipc'
import { RunnerHost } from './runner-host'
import { SafeStorageSecretStore } from './secret-store'
import { runSecretsHelper } from './secrets-helper'

// ---- pasta de dados: %APPDATA%/MUDO (ou MUDO_DATA_DIR) ----
const dataRoot = process.env.MUDO_DATA_DIR ? path.resolve(process.env.MUDO_DATA_DIR) : path.join(app.getPath('appData'), 'MUDO')
const paths = dataPaths(dataRoot)
ensureDataDirs(paths)
// cache/sessão do Chromium separados dos dados do app
app.setPath('userData', path.join(dataRoot, 'chromium'))
app.setPath('crashDumps', path.join(paths.logs, 'crash'))

const secretStore = new SafeStorageSecretStore(paths.config)
const helperMode = process.argv.includes('--mudo-secrets-helper')
if (!helperMode && !app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const orphanAfterMs = z.coerce.number().int().min(500).catch(DEFAULTS.orphanAfterMs).parse(process.env.MUDO_ORPHAN_MS ?? DEFAULTS.orphanAfterMs)

function migrationsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'migrations') : path.join(app.getAppPath(), 'migrations')
}

function toView(j: JobRow, v: { title: string | null; theme: string } | undefined): JobView {
  const parsedErr = jobErrorSchema.safeParse(j.lastError)
  const err = parsedErr.success ? parsedErr.data : null
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    stage: j.stage,
    progress: j.progress,
    attempt: j.attempt,
    maxAttempts: j.maxAttempts,
    lastError: err ? { code: err.code, message: err.message } : null,
    stageTimings: (j.stageTimings ?? {}) as Record<string, number>,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    finishedAt: j.finishedAt,
    title: v?.title ?? null,
    theme: v?.theme ?? null,
  }
}

async function main(): Promise<void> {
  const log = await createLogger(paths.logs, 'main')
  process.on('uncaughtException', (err) => log.fatal({ err }, 'exceção não tratada no main'))
  process.on('unhandledRejection', (err) => log.error({ err }, 'promise rejeitada sem tratamento no main'))

  await app.whenReady()

  const handle = openDatabase(paths.db)
  const mig = migrateDatabase(handle, { migrationsDir: migrationsDir(), backupDir: paths.backups })
  log.info({ dataRoot, applied: mig.applied, backup: mig.backupPath, version: app.getVersion() }, 'app iniciado')
  const queue = new JobQueue(handle)

  let win: BrowserWindow | null = null
  const broadcast = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const concurrency = getSetting(handle, SETTING_KEYS.concurrency, z.number().int().min(1).max(8), DEFAULTS.concurrency)
  const runner = new RunnerHost({
    dataDir: dataRoot,
    binDir: app.isPackaged ? path.join(process.resourcesPath, 'bin') : null,
    concurrency,
    orphanAfterMs,
    log,
    onMessage: (m) => {
      if (m.type === 'job-changed') broadcast('jobs:changed', { jobId: m.jobId })
      else if (m.type === 'get-secret') {
        // chave vai só para o runner (utilityProcess), nunca para o renderer
        void secretStore
          .get(m.id)
          .catch(() => null)
          .then((value) => runner.send({ type: 'secret', reqId: m.reqId, value }))
      }
    },
    onStatus: (s: RunnerStatus) => broadcast('runner:status', s),
  })

  const isTrustedSender = (e: IpcMainInvokeEvent) => win !== null && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame

  registerIpc(
    {
      'jobs:list': () => {
        const vids = new Map(listVideos(handle).map((v) => [v.id, v]))
        return queue.list().map((j) => toView(j, j.videoId ? vids.get(j.videoId) : undefined))
      },
      'jobs:cancel': ({ id }) => {
        const r = queue.cancel(id)
        if (!r.job) throw new UserFacingError('Job não encontrado.')
        if (!r.ok) return { ok: false, message: 'Este job não pode mais ser cancelado.' }
        if (r.wasRunning) runner.send({ type: 'check', jobId: id })
        else cleanupJobTemp(paths, r.job)
        log.info({ jobId: id, wasRunning: r.wasRunning }, 'job cancelado')
        broadcast('jobs:changed', { jobId: id })
        return { ok: true }
      },
      'jobs:resume': ({ id }) => {
        const r = queue.resume(id)
        if (!r.job) throw new UserFacingError('Job não encontrado.')
        if (!r.ok) return { ok: false, message: 'Só é possível retomar jobs falhos, cancelados ou aguardando ação.' }
        log.info({ jobId: id }, 'job retomado')
        runner.send({ type: 'poke' })
        broadcast('jobs:changed', { jobId: id })
        return { ok: true }
      },
      'runner:status': () => runner.getStatus(),
      'app:info': () => ({ version: app.getVersion(), dataDir: dataRoot, platform: process.platform }),
      'app:openLogs': async () => {
        const err = await shell.openPath(paths.logs)
        return err ? { ok: false, message: err } : { ok: true }
      },
    },
    log,
    isTrustedSender,
  )

  runner.start()

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: '#0b0d10',
      title: 'MUDO',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    })
    win.once('ready-to-show', () => win?.show())
    win.on('closed', () => (win = null))
    // nada de navegação ou janelas novas a partir do renderer
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.on('render-process-gone', (_e, d) => log.error({ reason: d.reason }, 'renderer encerrou'))

    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  createWindow()
  app.on('second-instance', () => {
    if (!win) createWindow()
    else {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => app.quit())

  let stopping = false
  app.on('before-quit', (e) => {
    if (stopping) return
    stopping = true
    e.preventDefault()
    void runner.stop().finally(() => {
      handle.close()
      log.info('app encerrado')
      app.exit(0)
    })
  })
}

if (helperMode) {
  void runSecretsHelper(secretStore)
} else main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  try {
    fs.appendFileSync(path.join(paths.logs, 'startup-error.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // sem onde registrar
  }
  app.exit(1)
})
