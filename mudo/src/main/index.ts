import { app, BrowserWindow, clipboard, net, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  JobError,
  JobQueue,
  SETTING_KEYS,
  cleanupJobTemp,
  configuredProviders,
  createLogger,
  createVideoJob,
  dataPaths,
  deleteVideo,
  ensureDataDirs,
  estimateVideoCost,
  getScriptForEdit,
  getSetting,
  getVideo,
  listVideoViews,
  migrateDatabase,
  openDatabase,
  saveEditedScript,
  videoMediaPath,
} from '../core'
import { DEFAULTS } from '../shared/enums'
import type { IpcOutput, RunnerStatus } from '../shared/ipc'
import { registerIpc, UserFacingError } from './ipc'
import { RunnerHost } from './runner-host'
import { cutsHandlers } from './cuts-handlers'
import { phase6Handlers } from './settings-handlers'
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

/** Protocolo só-leitura para o player e as thumbnails: o renderer nunca vê caminhos de disco. */
protocol.registerSchemesAsPrivileged([{ scheme: 'mudo-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

const modelsDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(app.getAppPath(), 'resources', 'models'))

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

  const importWaiters = new Map<number, (r: IpcOutput<'images:import'>) => void>()
  let nextImportId = 1
  const concurrency = getSetting(handle, SETTING_KEYS.concurrency, z.number().int().min(1).max(8), DEFAULTS.concurrency)
  const runner = new RunnerHost({
    dataDir: dataRoot,
    binDir: app.isPackaged ? path.join(process.resourcesPath, 'bin') : null,
    modelsDir: modelsDir(),
    concurrency,
    orphanAfterMs,
    log,
    onMessage: (m) => {
      if (m.type === 'job-changed') broadcast('jobs:changed', { jobId: m.jobId })
      else if (m.type === 'import-progress') broadcast('images:importProgress', { done: m.done, file: path.basename(m.file), status: m.status, reason: m.reason })
      else if (m.type === 'import-done') {
        const w = importWaiters.get(m.reqId)
        importWaiters.delete(m.reqId)
        w?.({ ok: !m.error, imported: m.imported, updated: m.updated, rejected: m.rejected, quarantined: m.quarantined, message: m.error })
      }
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

  const providers = configuredProviders(handle, secretStore, { modelsDir: modelsDir() })
  const jobOfVideo = (videoId: string) => {
    const j = queue.list(5000).find((x) => x.videoId === videoId)
    if (!j) throw new UserFacingError('Vídeo não encontrado.')
    return j
  }
  const userError = (fn: () => unknown) => {
    try {
      return fn()
    } catch (err) {
      if (err instanceof JobError && err.code === 'INVALID_INPUT') throw new UserFacingError(err.message)
      throw err
    }
  }

  protocol.handle('mudo-media', (req) => {
    const u = new URL(req.url)
    const kind = z.enum(['video', 'thumb', 'thumb2']).safeParse(u.hostname)
    const id = z.uuid().safeParse(u.pathname.replace(/^\//, ''))
    const file = kind.success && id.success ? videoMediaPath(handle, id.data, kind.data) : null
    if (!file) return new Response('não encontrado', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers })
  })

  const isTrustedSender = (e: IpcMainInvokeEvent) => win !== null && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame

  registerIpc(
    {
      ...cutsHandlers({ handle, paths, log, runner, window: () => win, broadcast }),
      ...phase6Handlers({
        handle,
        paths,
        log,
        secrets: secretStore,
        providers,
        runner,
        window: () => win,
        broadcast,
        importWaiters,
        nextImportId: () => nextImportId++,
      }),
      'videos:list': ({ onlyDone }) => listVideoViews(handle, { onlyDone }),
      'videos:estimate': async (req) => {
        try {
          return await estimateVideoCost(handle, providers, req)
        } catch (err) {
          if (err instanceof JobError && err.code === 'INVALID_INPUT') throw new UserFacingError(err.message)
          throw err
        }
      },
      'videos:create': (req) => {
        const { video, job } = userError(() => createVideoJob(handle, req)) as ReturnType<typeof createVideoJob>
        log.info({ videoId: video.id, jobId: job.id }, 'vídeo enfileirado pela interface')
        runner.send({ type: 'poke' })
        broadcast('jobs:changed', { jobId: job.id })
        return { videoId: video.id, jobId: job.id }
      },
      'videos:cancel': ({ id }) => {
        const j = jobOfVideo(id)
        const r = queue.cancel(j.id)
        if (!r.ok) return { ok: false, message: 'Este vídeo não pode mais ser cancelado.' }
        if (r.wasRunning) runner.send({ type: 'check', jobId: j.id })
        else if (r.job) cleanupJobTemp(paths, r.job)
        log.info({ videoId: id, wasRunning: r.wasRunning }, 'vídeo cancelado')
        broadcast('jobs:changed', { jobId: j.id })
        return { ok: true }
      },
      'videos:resume': ({ id }) => {
        const j = jobOfVideo(id)
        const r = queue.resume(j.id)
        if (!r.ok) return { ok: false, message: 'Só é possível retomar vídeos com falha, cancelados ou aguardando você.' }
        log.info({ videoId: id }, 'vídeo retomado')
        runner.send({ type: 'poke' })
        broadcast('jobs:changed', { jobId: j.id })
        return { ok: true }
      },
      'videos:getScript': ({ id }) => userError(() => getScriptForEdit(handle, paths, id)) as ReturnType<typeof getScriptForEdit>,
      'videos:saveScript': ({ id, acts }) => {
        const r = userError(() => saveEditedScript(handle, paths, id, acts)) as ReturnType<typeof saveEditedScript>
        log.info({ videoId: id, acts: acts.length }, 'roteiro editado pelo usuário')
        broadcast('jobs:changed', { jobId: null })
        return r
      },
      'videos:delete': ({ id }) => {
        userError(() => deleteVideo(handle, paths, id))
        log.info({ videoId: id }, 'vídeo apagado')
        broadcast('jobs:changed', { jobId: null })
        return { ok: true }
      },
      'videos:openFolder': ({ id }) => {
        const v = getVideo(handle, id)
        if (!v?.outputPath || !fs.existsSync(v.outputPath)) return { ok: false, message: 'O arquivo do vídeo não está mais na pasta de saída.' }
        shell.showItemInFolder(v.outputPath)
        return { ok: true }
      },
      'videos:copy': ({ id, field }) => {
        const v = getVideo(handle, id)
        const text = field === 'title' ? v?.title : v?.description
        if (!text) return { ok: false, message: 'Ainda não há texto para copiar.' }
        clipboard.writeText(text)
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
