import { app, dialog, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from 'pino'
import { z } from 'zod'
import {
  JobError,
  OUTPUT_DIR_SETTING,
  PROVIDER_SETTINGS,
  SETTING_KEYS,
  channelPreset,
  createChannel,
  defaultOutputDir,
  getSetting,
  listChannels,
  quotaStatus,
  removeChannel,
  setPlan,
  setSetting,
  testConnection,
  updateChannel,
  videoLicenses,
  videosWithLicenses,
  writeLicensesCsv,
  setImageCredit,
  type ChannelRow,
  type DataPaths,
  type DbHandle,
  type ProviderSource,
} from '../core'
import { listImages, setImageLicense } from '../core/images/library'
import { SECRET_LABELS } from '../core/secrets'
import { DEFAULTS, MUSIC_MOODS, type Language } from '../shared/enums'
import type { ChannelSummary, IpcOutput, SettingsView } from '../shared/ipc'
import { DEFAULT_PLAN, PLAN_IDS } from '../shared/plans'
import { UserFacingError, type IpcHandlers } from './ipc'
import type { RunnerHost } from './runner-host'
import type { SafeStorageSecretStore } from './secret-store'

export const LIBRARY_DIR_SETTING = 'images.libraryDir'

const PREVIEW_TEXT: Record<Language, string> = {
  'pt-BR': 'Olá! Esta é a voz do seu canal. É assim que a narração vai soar nos vídeos.',
  es: '¡Hola! Esta es la voz de tu canal. Así sonará la narración en los videos.',
  en: 'Hi! This is your channel voice. This is how the narration will sound in your videos.',
}

interface Ctx {
  handle: DbHandle
  paths: DataPaths
  log: Logger
  secrets: SafeStorageSecretStore
  providers: ProviderSource
  runner: RunnerHost
  window: () => BrowserWindow | null
  broadcast: (channel: string, payload: unknown) => void
  /** Pedidos de importação em andamento no runner. */
  importWaiters: Map<number, (r: IpcOutput<'images:import'>) => void>
  nextImportId: () => number
}

const userError = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (err) {
    if (err instanceof JobError && err.code === 'INVALID_INPUT') throw new UserFacingError(err.message)
    throw err
  }
}

export function channelSummary(h: DbHandle, c: ChannelRow): ChannelSummary {
  const count = h.sqlite.prepare('SELECT COUNT(*) AS n FROM videos WHERE channel_id = ?').get(c.id) as { n: number }
  return {
    id: c.id,
    name: c.name,
    niche: c.niche,
    language: z.enum(['pt-BR', 'es', 'en']).catch('pt-BR').parse(c.language),
    ttsProvider: z.enum(['elevenlabs', 'openai', 'azure']).nullable().catch(null).parse(c.ttsProvider),
    voiceId: c.voiceId,
    musicMood: z.enum(MUSIC_MOODS).nullable().catch(null).parse(c.musicMood),
    stylePreset: channelPreset(c),
    videoCount: count.n,
  }
}

function readSettings(c: Ctx): SettingsView {
  const h = c.handle
  const str = z.string().min(1)
  return {
    configuredKeys: c.secrets.configured(),
    llmOrder: getSetting(h, PROVIDER_SETTINGS.llmOrder, z.array(z.enum(['anthropic', 'openai', 'gemini'])).min(1), ['anthropic', 'openai', 'gemini']),
    ttsOrder: getSetting(h, PROVIDER_SETTINGS.ttsOrder, z.array(z.enum(['elevenlabs', 'openai', 'azure'])).min(1), ['elevenlabs', 'openai', 'azure']),
    imagesOrder: getSetting(h, PROVIDER_SETTINGS.stockOrder, z.array(z.enum(['pexels', 'pixabay'])).min(1), ['pexels', 'pixabay']),
    imageGeneration: getSetting(h, PROVIDER_SETTINGS.imageGenEnabled, z.boolean(), true),
    embeddings: getSetting(h, PROVIDER_SETTINGS.embeddings, z.enum(['clip', 'openai']), 'clip'),
    anthropicModel: getSetting(h, PROVIDER_SETTINGS.anthropicModel, str, 'claude-opus-5-5'),
    anthropicEffort: getSetting(h, PROVIDER_SETTINGS.anthropicEffort, z.enum(['low', 'medium', 'high', 'xhigh', 'max']), 'medium'),
    openaiLlmModel: getSetting(h, PROVIDER_SETTINGS.openaiLlmModel, str, 'gpt-5'),
    openaiTtsModel: getSetting(h, PROVIDER_SETTINGS.openaiTtsModel, str, 'gpt-4o-mini-tts'),
    geminiModel: getSetting(h, PROVIDER_SETTINGS.geminiModel, str, 'gemini-2.5-pro'),
    elevenlabsModel: getSetting(h, PROVIDER_SETTINGS.elevenlabsModel, str, 'eleven_multilingual_v2'),
    azureRegion: getSetting(h, PROVIDER_SETTINGS.azureRegion, z.string().regex(/^[a-z0-9]*$/), ''),
    outputDir: getSetting(h, OUTPUT_DIR_SETTING, str, defaultOutputDir()),
    libraryDir: getSetting(h, LIBRARY_DIR_SETTING, z.string(), ''),
    concurrency: getSetting(h, SETTING_KEYS.concurrency, z.number().int().min(1).max(8), DEFAULTS.concurrency),
    planId: getSetting(h, 'plan.id', z.enum(PLAN_IDS), DEFAULT_PLAN),
  }
}

function legalDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'assets', 'legal') : path.join(app.getAppPath(), 'assets', 'legal')
}

type Phase6 = Pick<
  IpcHandlers,
  | 'channels:list'
  | 'channels:save'
  | 'channels:remove'
  | 'channels:previewVoice'
  | 'licenses:videos'
  | 'licenses:forVideo'
  | 'licenses:exportCsv'
  | 'licenses:setCredit'
  | 'images:list'
  | 'images:setLicense'
  | 'images:import'
  | 'settings:get'
  | 'settings:save'
  | 'settings:chooseFolder'
  | 'keys:set'
  | 'keys:delete'
  | 'keys:test'
  | 'quota:status'
  | 'app:legal'
>

export function phase6Handlers(c: Ctx): Phase6 {
  const h = c.handle
  return {
    'channels:list': () => listChannels(h).map((ch) => channelSummary(h, ch)),
    'channels:save': ({ id, channel }) => {
      const row = userError(() => (id ? updateChannel(h, id, channel) : createChannel(h, channel)))
      c.log.info({ channelId: row.id, created: !id }, 'canal salvo')
      c.broadcast('jobs:changed', { jobId: null })
      return channelSummary(h, row)
    },
    'channels:remove': ({ id }) => {
      const result = userError(() => removeChannel(h, id))
      c.log.info({ channelId: id, result }, 'canal removido')
      return { ok: true, result }
    },
    'channels:previewVoice': async ({ language, ttsProvider, voiceId }) => {
      const all = await c.providers.tts()
      const p = (ttsProvider ? all.find((x) => x.id === ttsProvider) : undefined) ?? all[0]
      if (!p) throw new UserFacingError('Nenhum provedor de narração configurado. Adicione uma chave em Configurações.')
      if (ttsProvider && p.id !== ttsProvider) throw new UserFacingError(`O provedor ${ttsProvider} não está configurado. Adicione a chave em Configurações.`)
      try {
        const out = await p.call({ text: PREVIEW_TEXT[language], voiceId: voiceId || p.defaultVoice(language), language }, AbortSignal.timeout(30_000))
        return { provider: p.id, dataUrl: `data:audio/${out.ext === 'wav' ? 'wav' : 'mpeg'};base64,${out.audio.toString('base64')}` }
      } catch (err) {
        c.log.warn({ provider: p.id, err: err instanceof Error ? err.message : String(err) }, 'prévia de voz falhou')
        throw new UserFacingError(`A prévia da voz falhou em ${p.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    'licenses:videos': () => videosWithLicenses(h),
    'licenses:forVideo': ({ id }) => videoLicenses(h, id),
    'licenses:exportCsv': async ({ ids }) => {
      const w = c.window()
      const opts = { title: 'Exportar licenças (CSV)', defaultPath: path.join(app.getPath('documents'), 'licencas-mudo.csv'), filters: [{ name: 'CSV', extensions: ['csv'] }] }
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false, path: null, rows: 0 }
      const rows = writeLicensesCsv(h, ids, r.filePath)
      return { ok: true, path: r.filePath, rows }
    },
    'licenses:setCredit': ({ imageId, credit }) => {
      setImageCredit(h, imageId, credit)
      return { ok: true }
    },
    'images:list': ({ quarantine }) =>
      listImages(h, { quarantine }).map((i) => ({
        id: i.id,
        fileName: path.basename(i.path),
        source: i.source,
        license: i.license,
        author: i.author,
        creditText: i.creditText,
        width: i.width,
        height: i.height,
        usedCount: i.usedCount,
      })),
    'images:setLicense': ({ id, license, credit }) => {
      userError(() => setImageLicense(h, id, license, credit))
      return { ok: true }
    },
    'images:import': async ({ license, credit }) => {
      const dir = getSetting(h, LIBRARY_DIR_SETTING, z.string(), '')
      if (!dir || !fs.existsSync(dir)) throw new UserFacingError('Escolha a pasta do acervo em Configurações antes de importar.')
      const reqId = c.nextImportId()
      return new Promise((resolve) => {
        c.importWaiters.set(reqId, resolve)
        c.runner.send({ type: 'import-images', reqId, target: dir, license, credit, author: null })
      })
    },
    'settings:get': () => readSettings(c),
    'settings:save': (patch) => {
      const keys: Array<[keyof typeof patch, string]> = [
        ['llmOrder', PROVIDER_SETTINGS.llmOrder],
        ['ttsOrder', PROVIDER_SETTINGS.ttsOrder],
        ['imagesOrder', PROVIDER_SETTINGS.stockOrder],
        ['imageGeneration', PROVIDER_SETTINGS.imageGenEnabled],
        ['embeddings', PROVIDER_SETTINGS.embeddings],
        ['anthropicModel', PROVIDER_SETTINGS.anthropicModel],
        ['anthropicEffort', PROVIDER_SETTINGS.anthropicEffort],
        ['openaiLlmModel', PROVIDER_SETTINGS.openaiLlmModel],
        ['openaiTtsModel', PROVIDER_SETTINGS.openaiTtsModel],
        ['geminiModel', PROVIDER_SETTINGS.geminiModel],
        ['elevenlabsModel', PROVIDER_SETTINGS.elevenlabsModel],
        ['azureRegion', PROVIDER_SETTINGS.azureRegion],
        ['outputDir', OUTPUT_DIR_SETTING],
        ['libraryDir', LIBRARY_DIR_SETTING],
        ['concurrency', SETTING_KEYS.concurrency],
      ]
      for (const [field, key] of keys) if (patch[field] !== undefined) setSetting(h, key, patch[field])
      if (patch.planId) setPlan(h, patch.planId)
      if (patch.concurrency) c.runner.send({ type: 'setConcurrency', concurrency: patch.concurrency })
      c.log.info({ fields: Object.keys(patch) }, 'configurações salvas')
      return readSettings(c)
    },
    'settings:chooseFolder': async ({ purpose }) => {
      const w = c.window()
      const opts = { title: purpose === 'output' ? 'Pasta de saída dos vídeos' : 'Pasta do acervo de imagens', properties: ['openDirectory' as const, 'createDirectory' as const] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return { path: r.canceled ? null : (r.filePaths[0] ?? null) }
    },
    'keys:set': ({ id, value }) => {
      try {
        c.secrets.set(id, value)
      } catch (err) {
        throw new UserFacingError(err instanceof Error ? err.message : String(err))
      }
      c.log.info({ provider: id }, 'chave guardada') // nunca o valor
      return { ok: true, message: `Chave de ${SECRET_LABELS[id]} guardada no cofre do sistema.` }
    },
    'keys:delete': ({ id }) => {
      c.secrets.delete(id)
      c.log.info({ provider: id }, 'chave removida')
      return { ok: true }
    },
    'keys:test': async ({ id }) => {
      const key = await c.secrets.get(id)
      if (!key) return { ok: false, message: 'Nenhuma chave guardada para este provedor.', latencyMs: 0 }
      const r = await testConnection(id, key, { azureRegion: getSetting(h, PROVIDER_SETTINGS.azureRegion, z.string(), '') || undefined })
      c.log.info({ provider: id, ok: r.ok, latencyMs: r.latencyMs }, 'teste de conexão')
      return r
    },
    'quota:status': () => {
      const q = quotaStatus(h)
      return {
        planId: q.plan.id,
        planName: q.plan.name,
        month: q.month,
        videosUsed: q.videosUsed,
        videosPending: q.videosPending,
        videosLimit: q.videosLimit,
        videosRemaining: q.videosRemaining,
        cutsUsed: q.cutsUsed,
        cutsLimit: q.cutsLimit,
        cutsRemaining: q.cutsRemaining,
      }
    },
    'app:legal': ({ doc }) => {
      const file = path.join(legalDir(), `${doc}.md`)
      const titles = { terms: 'Termos de uso', privacy: 'Privacidade', 'third-party': 'Licenças de terceiros' } as const
      return { title: titles[doc], text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'Documento não encontrado na instalação.' }
    },
  }
}

