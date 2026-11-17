import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { z } from 'zod'
import {
  JobError,
  JobQueue,
  Runner,
  cleanupJobTemp,
  createChannel,
  createVideoJob,
  dataPaths,
  ensureDataDirs,
  estimateVideoCost,
  getVideo,
  jobErrorSchema,
  jobHandlers,
  listChannels,
  listVideos,
  migrateDatabase,
  nullLogger,
  openDatabase,
  setSetting,
  type DbHandle,
  type JobRow,
  type Logger,
  type MediaBinaries,
  type ProviderSource,
} from '../core'
import { SECRET_IDS, secretIdSchema, SECRET_LABELS } from '../core/secrets'
import { DURATION, LANGUAGES, STAGE_LABELS, TERMINAL_STATES, type JobState } from '../shared/enums'
import type { SecretsAdmin } from './helper-secrets'

/** Códigos de saída estáveis (seção 13). */
export const EXIT = { ok: 0, error: 1, invalid: 2, quota: 3 } as const

export interface CliIO {
  out(s: string): void
  err(s: string): void
  /** Lê todo o stdin (para `keys set`, que nunca recebe a chave por argumento). */
  readStdin(): Promise<string>
}

export interface CliDeps {
  dataRoot: string
  migrationsDir: string
  providers: (h: DbHandle) => ProviderSource
  media: MediaBinaries
  secrets?: SecretsAdmin
  log?: Logger
  io: CliIO
  /** Intervalo de atualização do `--wait` (testes usam menor). */
  pollMs?: number
}

class UsageError extends Error {}

const USAGE = `Uso:
  mudo generate --theme "..." --channel <id> [--lang pt-BR|es|en] [--duration 420] [--wait] [--json]
  mudo status <jobId> [--json]
  mudo resume <jobId> [--wait] [--json]
  mudo cancel <jobId> [--json]
  mudo library list [--json]
  mudo channel create --name "..." --niche "..." --lang pt-BR [--tts elevenlabs|openai|azure] [--voice <id>] [--manual-review] [--json]
  mudo channel list [--json]
  mudo estimate --theme "..." --channel <id> [--lang ...] [--duration 420] [--json]
  mudo keys set <${SECRET_IDS.join('|')}>      (lê a chave do stdin)
  mudo keys list | mudo keys delete <id>
  mudo config set <chave> <valor>

Saída: 0 ok · 1 erro · 2 entrada inválida · 3 cota`

/** Configurações aceitas por `mudo config set` (Configurações completas chegam na tela). */
const CONFIG_KEYS: Record<string, z.ZodType> = {
  'output.dir': z.string().min(1),
  'runner.concurrency': z.coerce.number().int().min(1).max(8),
  'providers.llm.order': z.string().transform((s) => s.split(',').map((x) => x.trim())).pipe(z.array(z.enum(['anthropic', 'openai', 'gemini'])).min(1)),
  'providers.tts.order': z.string().transform((s) => s.split(',').map((x) => x.trim())).pipe(z.array(z.enum(['elevenlabs', 'openai', 'azure'])).min(1)),
  'providers.anthropic.model': z.string().min(1),
  'providers.anthropic.effort': z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  'providers.openai.llmModel': z.string().min(1),
  'providers.openai.ttsModel': z.string().min(1),
  'providers.gemini.model': z.string().min(1),
  'providers.elevenlabs.model': z.string().min(1),
  'providers.azure.region': z.string().regex(/^[a-z0-9]+$/),
  'speech.wpm.pt-BR': z.coerce.number().int().min(80).max(260),
  'speech.wpm.es': z.coerce.number().int().min(80).max(260),
  'speech.wpm.en': z.coerce.number().int().min(80).max(260),
}

export interface JobStatusJson {
  jobId: string
  videoId: string | null
  state: JobState
  stage: string | null
  progress: number
  attempt: number
  error: { code: string; message: string } | null
  title: string | null
  outputPath: string | null
  costCents: number
  genTimeS: number | null
  actualDurationS: number | null
}

function statusJson(h: DbHandle, j: JobRow): JobStatusJson {
  const v = j.videoId ? getVideo(h, j.videoId) : undefined
  const e = jobErrorSchema.safeParse(j.lastError)
  return {
    jobId: j.id,
    videoId: j.videoId,
    state: j.state,
    stage: j.stage,
    progress: Math.round(j.progress * 1000) / 1000,
    attempt: j.attempt,
    error: e.success ? { code: e.data.code, message: e.data.message } : null,
    title: v?.title ?? null,
    outputPath: v?.outputPath ?? null,
    costCents: Math.round(j.costCents * 100) / 100,
    genTimeS: v?.genTimeS ?? null,
    actualDurationS: v?.actualDurationS ?? null,
  }
}

const money = (cents: number) => `US$ ${(cents / 100).toFixed(2)}`

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { io } = deps
  try {
    return await dispatch(argv, deps)
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`${err.message}\n\n${USAGE}\n`)
      return EXIT.invalid
    }
    if (err instanceof JobError && err.code === 'INVALID_INPUT') {
      io.err(`Entrada inválida: ${err.message}\n`)
      return EXIT.invalid
    }
    if (err instanceof JobError && err.code === 'QUOTA_EXCEEDED') {
      io.err(`${err.message}\n`)
      return EXIT.quota
    }
    deps.log?.error({ err }, 'erro na CLI')
    io.err(`Erro: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.error
  }
}

function open(deps: CliDeps): DbHandle {
  const paths = dataPaths(deps.dataRoot)
  ensureDataDirs(paths)
  const h = openDatabase(paths.db)
  migrateDatabase(h, { migrationsDir: deps.migrationsDir, backupDir: paths.backups })
  return h
}

async function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, sub, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    deps.io.out(`${USAGE}\n`)
    return cmd ? EXIT.ok : EXIT.invalid
  }
  switch (cmd) {
    case 'generate':
      return generate([sub, ...rest].filter((x): x is string => x !== undefined), deps)
    case 'status':
    case 'resume':
    case 'cancel':
      return jobCommand(cmd, [sub, ...rest].filter((x): x is string => x !== undefined), deps)
    case 'library':
      if (sub !== 'list') throw new UsageError('use: mudo library list')
      return libraryList(rest, deps)
    case 'channel':
      if (sub === 'create') return channelCreate(rest, deps)
      if (sub === 'list') return channelList(rest, deps)
      throw new UsageError('use: mudo channel create|list')
    case 'estimate':
      return estimate([sub, ...rest].filter((x): x is string => x !== undefined), deps)
    case 'keys':
      return keys(sub, rest, deps)
    case 'config':
      return config(sub, rest, deps)
    default:
      throw new UsageError(`comando desconhecido: ${cmd}`)
  }
}

function parse<const T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true } as const)
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

const durationOpt = (v: string | undefined) => {
  if (v === undefined) return DURATION.defaultS
  const n = Number(v)
  if (!Number.isInteger(n)) throw new JobError('INVALID_INPUT', '--duration deve ser um número inteiro de segundos')
  return n
}
const langOpt = (v: string | undefined) => {
  if (v === undefined) return undefined
  const r = z.enum(LANGUAGES).safeParse(v)
  if (!r.success) throw new JobError('INVALID_INPUT', `--lang deve ser ${LANGUAGES.join(', ')}`)
  return r.data
}

async function generate(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, {
    theme: { type: 'string' },
    channel: { type: 'string' },
    lang: { type: 'string' },
    duration: { type: 'string' },
    wait: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  })
  if (!values.theme || !values.channel) throw new UsageError('generate precisa de --theme e --channel')
  const h = open(deps)
  try {
    const { video, job } = createVideoJob(h, {
      channelId: values.channel,
      theme: values.theme,
      language: langOpt(values.lang),
      durationS: durationOpt(values.duration),
    })
    deps.log?.info({ jobId: job.id, videoId: video.id }, 'vídeo enfileirado pela CLI')
    if (!values.wait) {
      if (values.json) deps.io.out(`${JSON.stringify(statusJson(h, job))}\n`)
      else deps.io.out(`Vídeo enfileirado.\njobId: ${job.id}\nvideoId: ${video.id}\nAcompanhe com: mudo status ${job.id}\n`)
      return EXIT.ok
    }
    return await waitFor(h, job.id, deps, !!values.json)
  } finally {
    h.close()
  }
}

/** Processa o job no próprio processo (só ele) e acompanha até terminar ou precisar de você. */
async function waitFor(h: DbHandle, jobId: string, deps: CliDeps, json: boolean): Promise<number> {
  const paths = dataPaths(deps.dataRoot)
  const runner = new Runner({
    handle: h,
    paths,
    log: deps.log ?? nullLogger(),
    handlers: jobHandlers,
    providers: deps.providers(h),
    media: deps.media,
    concurrency: 1,
    onlyJobIds: new Set([jobId]),
  })
  const queue = runner.queue
  runner.start()
  let lastLine = ''
  try {
    for (;;) {
      const j = queue.get(jobId)
      if (!j) throw new Error('job sumiu do banco')
      if (!json) {
        const line = j.stage ? `${STAGE_LABELS[j.stage]} ${Math.round(j.progress * 100)}%` : 'na fila'
        if (line !== lastLine) {
          deps.io.err(`${line}\n`)
          lastLine = line
        }
      }
      if (TERMINAL_STATES.includes(j.state) || j.state === 'needs_input') break
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 500))
    }
  } finally {
    await runner.stop()
  }
  const j = queue.get(jobId)!
  const s = statusJson(h, j)
  if (json) deps.io.out(`${JSON.stringify(s)}\n`)
  else if (s.state === 'done') {
    deps.io.out(
      `Pronto: ${s.outputPath}\nTítulo: ${s.title}\nDuração: ${s.actualDurationS?.toFixed(1)} s · Geração: ${s.genTimeS} s · Custo: ${money(s.costCents)}\n` +
        'Ao publicar, marque a opção de conteúdo alterado ou sintético da plataforma — o metadado do arquivo não faz isso sozinho.\n',
    )
  } else deps.io.out(`Estado: ${s.state}${s.error ? ` — ${s.error.code}: ${s.error.message}` : ''}\n`)
  return s.state === 'done' ? EXIT.ok : EXIT.error
}

async function jobCommand(cmd: 'status' | 'resume' | 'cancel', args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: 'boolean', default: false }, wait: { type: 'boolean', default: false } })
  const id = positionals[0]
  if (!id) throw new UsageError(`${cmd} precisa do jobId`)
  const h = open(deps)
  try {
    const q = new JobQueue(h)
    const job = q.get(id)
    if (!job) throw new JobError('INVALID_INPUT', `job não encontrado: ${id}`)
    if (cmd === 'resume') {
      const r = q.resume(id)
      if (!r.ok) throw new JobError('INVALID_INPUT', `o job está "${job.state}"; só é possível retomar jobs falhos, cancelados ou aguardando você`)
      if (values.wait) return await waitFor(h, id, deps, !!values.json)
    } else if (cmd === 'cancel') {
      const r = q.cancel(id)
      if (!r.ok) throw new JobError('INVALID_INPUT', `o job está "${job.state}" e não pode ser cancelado`)
      // se outro processo estiver rodando, ele percebe a perda de posse e limpa; aqui limpa o que der
      if (!r.wasRunning) cleanupJobTemp(dataPaths(deps.dataRoot), job)
    }
    const s = statusJson(h, q.get(id)!)
    if (values.json) deps.io.out(`${JSON.stringify(s)}\n`)
    else {
      deps.io.out(
        [
          `Job ${s.jobId}`,
          `Estado: ${s.state}${s.stage ? ` · etapa ${STAGE_LABELS[s.stage as keyof typeof STAGE_LABELS]}` : ''} · ${Math.round(s.progress * 100)}%`,
          s.title ? `Título: ${s.title}` : '',
          s.error ? `Motivo: ${s.error.code} — ${s.error.message}` : '',
          s.outputPath ? `Arquivo: ${s.outputPath}` : '',
          `Custo até agora: ${money(s.costCents)}`,
        ]
          .filter(Boolean)
          .join('\n') + '\n',
      )
    }
    return EXIT.ok
  } finally {
    h.close()
  }
}

async function libraryList(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean', default: false } })
  const h = open(deps)
  try {
    const rows = listVideos(h).filter((v) => v.state === 'done')
    const items = rows.map((v) => ({
      videoId: v.id,
      channelId: v.channelId,
      title: v.title,
      theme: v.theme,
      language: v.language,
      durationS: v.actualDurationS,
      costCents: Math.round(v.costCents * 100) / 100,
      outputPath: v.outputPath,
      createdAt: new Date(v.createdAt).toISOString(),
      finishedAt: v.finishedAt ? new Date(v.finishedAt).toISOString() : null,
    }))
    if (values.json) deps.io.out(`${JSON.stringify(items)}\n`)
    else if (items.length === 0) deps.io.out('Nenhum vídeo pronto ainda.\n')
    else for (const i of items) deps.io.out(`${i.finishedAt?.slice(0, 10)}  ${i.durationS?.toFixed(0)} s  ${money(i.costCents)}  ${i.title}\n    ${i.outputPath}\n`)
    return EXIT.ok
  } finally {
    h.close()
  }
}

async function channelCreate(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, {
    name: { type: 'string' },
    niche: { type: 'string' },
    lang: { type: 'string' },
    tts: { type: 'string' },
    voice: { type: 'string' },
    style: { type: 'string' },
    'manual-review': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  })
  if (!values.name || !values.niche || !values.lang) throw new UsageError('channel create precisa de --name, --niche e --lang')
  const h = open(deps)
  try {
    const tts = values.tts === undefined ? undefined : z.enum(['elevenlabs', 'openai', 'azure']).safeParse(values.tts)
    if (tts && !tts.success) throw new JobError('INVALID_INPUT', '--tts deve ser elevenlabs, openai ou azure')
    let c
    try {
      c = createChannel(h, {
        name: values.name,
        niche: values.niche,
        language: langOpt(values.lang)!,
        ttsProvider: tts?.data,
        voiceId: values.voice,
        stylePreset: { manualReview: !!values['manual-review'], ...(values.style ? { scriptStyle: values.style } : {}) },
      })
    } catch (e) {
      if (e instanceof z.ZodError) throw new JobError('INVALID_INPUT', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      throw e
    }
    if (values.json) deps.io.out(`${JSON.stringify({ channelId: c.id, name: c.name, language: c.language })}\n`)
    else deps.io.out(`Canal criado: ${c.name}\nchannelId: ${c.id}\n`)
    return EXIT.ok
  } finally {
    h.close()
  }
}

async function channelList(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, { json: { type: 'boolean', default: false } })
  const h = open(deps)
  try {
    const rows = listChannels(h).map((c) => ({ channelId: c.id, name: c.name, niche: c.niche, language: c.language, ttsProvider: c.ttsProvider, voiceId: c.voiceId }))
    if (values.json) deps.io.out(`${JSON.stringify(rows)}\n`)
    else if (rows.length === 0) deps.io.out('Nenhum canal. Crie com: mudo channel create --name "..." --niche "..." --lang pt-BR\n')
    else for (const c of rows) deps.io.out(`${c.channelId}  ${c.name} (${c.language}) — ${c.niche}\n`)
    return EXIT.ok
  } finally {
    h.close()
  }
}

async function estimate(args: string[], deps: CliDeps): Promise<number> {
  const { values } = parse(args, {
    theme: { type: 'string' },
    channel: { type: 'string' },
    lang: { type: 'string' },
    duration: { type: 'string' },
    json: { type: 'boolean', default: false },
  })
  if (!values.theme || !values.channel) throw new UsageError('estimate precisa de --theme e --channel')
  const h = open(deps)
  try {
    const e = await estimateVideoCost(h, deps.providers(h), {
      channelId: values.channel,
      theme: values.theme,
      language: langOpt(values.lang),
      durationS: durationOpt(values.duration),
    })
    const cents = Math.round(e.totalCents * 100) / 100
    if (values.json) deps.io.out(`${JSON.stringify({ totalCents: cents, breakdown: e.breakdown, missing: e.missing })}\n`)
    else {
      deps.io.out(`Custo estimado: ${money(cents)}\n`)
      for (const b of e.breakdown) deps.io.out(`  ${b.stage.padEnd(8)} ${String(b.provider).padEnd(11)} ${money(b.cents)}\n`)
      if (e.missing.length > 0) deps.io.out(`Sem provedor configurado para: ${e.missing.join(', ')} (mudo keys set ...)\n`)
    }
    return EXIT.ok
  } finally {
    h.close()
  }
}

async function keys(sub: string | undefined, rest: string[], deps: CliDeps): Promise<number> {
  if (!deps.secrets) throw new Error('gerência de chaves indisponível neste ambiente')
  if (sub === 'list') {
    const ids = await deps.secrets.list()
    for (const id of SECRET_IDS) deps.io.out(`${ids.includes(id) ? '✓' : '·'} ${id.padEnd(13)} ${SECRET_LABELS[id]}\n`)
    return EXIT.ok
  }
  const id = secretIdSchema.safeParse(rest[0])
  if (!id.success) throw new UsageError(`informe o provedor: ${SECRET_IDS.join(', ')}`)
  if (sub === 'set') {
    const value = (await deps.io.readStdin()).trim()
    if (!value) throw new JobError('INVALID_INPUT', 'nenhuma chave recebida no stdin')
    await deps.secrets.set(id.data, value)
    deps.io.out(`Chave de ${SECRET_LABELS[id.data]} guardada (cifrada com o cofre do sistema).\n`)
    return EXIT.ok
  }
  if (sub === 'delete') {
    await deps.secrets.remove(id.data)
    deps.io.out(`Chave de ${SECRET_LABELS[id.data]} removida.\n`)
    return EXIT.ok
  }
  throw new UsageError('use: mudo keys set|list|delete')
}

async function config(sub: string | undefined, rest: string[], deps: CliDeps): Promise<number> {
  if (sub !== 'set') throw new UsageError('use: mudo config set <chave> <valor>')
  const [key, value] = rest
  const schema = key ? CONFIG_KEYS[key] : undefined
  if (!key || !schema || value === undefined) throw new UsageError(`chaves aceitas: ${Object.keys(CONFIG_KEYS).join(', ')}`)
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new JobError('INVALID_INPUT', `valor inválido para ${key}: ${parsed.error.issues[0]?.message}`)
  const h = open(deps)
  try {
    setSetting(h, key, parsed.data)
    deps.io.out(`${key} = ${JSON.stringify(parsed.data)}\n`)
    return EXIT.ok
  } finally {
    h.close()
  }
}

