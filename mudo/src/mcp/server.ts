/**
 * Servidor MCP (seção 14): expõe geração de vídeo, estado de job, biblioteca,
 * criação de canal e estimativa de custo para assistentes compatíveis com MCP.
 *
 * A geração é assíncrona: `generate_video` só enfileira e devolve o jobId; um
 * runner neste mesmo processo processa os jobs pedidos por aqui, e
 * `job_status` acompanha. A `idempotency_key` evita vídeo duplicado quando o
 * cliente repete o pedido.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  JobError,
  JobQueue,
  Runner,
  createChannel,
  createVideoJobIdempotent,
  estimateVideoCost,
  jobHandlers,
  listVideos,
  pendingIdempotentJobIds,
  statusJson,
  type DataPaths,
  type DbHandle,
  type Logger,
  type MediaBinaries,
  type ProviderSource,
} from '../core'
import { DURATION, LANGUAGES, MUSIC_MOODS } from '../shared/enums'

export interface McpDeps {
  handle: DbHandle
  paths: DataPaths
  providers: ProviderSource
  media: MediaBinaries
  log: Logger
  version: string
  /** Intervalo do runner (testes usam menor). */
  pollMs?: number
}

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
})

/** Erros viram resultado de ferramenta com código estável (o cliente decide o que fazer). */
function fail(err: unknown, log: Logger): CallToolResult {
  let code = 'INTERNAL'
  let message = err instanceof Error ? err.message : String(err)
  if (err instanceof JobError) code = err.code
  else if (err instanceof z.ZodError) {
    code = 'INVALID_INPUT'
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  } else log.error({ err }, 'erro numa ferramenta MCP')
  const data = { error: { code, message } }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}

const videoInput = {
  theme: z.string().min(3).max(500).describe('Tema do vídeo'),
  channel_id: z.string().min(1).describe('Canal (veja channel_create ou a tela Canais)'),
  language: z.enum(LANGUAGES).optional().describe('Idioma; padrão: o do canal'),
  duration_s: z
    .number()
    .int()
    .min(DURATION.shortTestMinS)
    .max(DURATION.maxS)
    .optional()
    .describe(`Duração alvo em segundos (padrão ${DURATION.defaultS})`),
}

export function createMcpServer(deps: McpDeps): { server: McpServer; runner: Runner; close(): Promise<void> } {
  const { handle: h, log } = deps
  const queue = new JobQueue(h)
  // só os jobs pedidos por este servidor (o app tem o próprio runner para os da tela)
  const mine = new Set<string>(pendingIdempotentJobIds(h))
  const runner = new Runner({
    handle: h,
    paths: deps.paths,
    log,
    handlers: jobHandlers,
    providers: deps.providers,
    media: deps.media,
    onlyJobIds: mine,
    ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    onChange: (jobId) => {
      const j = queue.get(jobId)
      if (j && !['queued', 'running'].includes(j.state)) mine.delete(jobId)
    },
  })

  const server = new McpServer({ name: 'mudo', version: deps.version })
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean },
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await fn(args))
      } catch (e) {
        return fail(e, log)
      }
    }) as never)

  tool(
    'generate_video',
    'Enfileira a geração de um vídeo narrado e devolve na hora o jobId (a geração leva minutos). ' +
      'Acompanhe com job_status. Repetir o pedido com a mesma idempotency_key devolve o mesmo vídeo, sem gerar outro.',
    {
      ...videoInput,
      idempotency_key: z
        .string()
        .min(8)
        .max(200)
        .optional()
        .describe('Chave única do pedido; reenviar com a mesma chave não duplica o vídeo'),
    },
    { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    (a) => {
      const key = a.idempotency_key ?? `auto:${randomUUID()}`
      const { video, job, reused } = createVideoJobIdempotent(
        h,
        { channelId: a.channel_id, theme: a.theme, language: a.language, durationS: a.duration_s ?? DURATION.defaultS },
        key,
      )
      if (job.state === 'queued' || job.state === 'running') mine.add(job.id)
      log.info({ jobId: job.id, videoId: video.id, reused }, 'vídeo pedido pelo MCP')
      return { ...statusJson(h, job), reused }
    },
  )

  tool(
    'job_status',
    'Estado de um job: etapa, progresso, erro (com código), título, caminho do MP4 e custo. ' +
      'Estado "needs_input" significa que o MUDO precisa de você (ex.: chave faltando ou roteiro reprovado) — resolva no app.',
    { job_id: z.string().min(1) },
    { readOnlyHint: true },
    (a) => {
      const j = queue.get(a.job_id)
      if (!j) throw new JobError('INVALID_INPUT', `job não encontrado: ${a.job_id}`)
      return statusJson(h, j)
    },
  )

  tool(
    'library_list',
    'Vídeos prontos, do mais recente ao mais antigo, com título, duração, custo e caminho do arquivo.',
    { limit: z.number().int().min(1).max(500).optional().describe('Máximo de itens (padrão 50)') },
    { readOnlyHint: true },
    (a) => {
      const items = listVideos(h)
        .filter((v) => v.state === 'done')
        .slice(0, a.limit ?? 50)
        .map((v) => ({
          videoId: v.id,
          channelId: v.channelId,
          title: v.title,
          theme: v.theme,
          language: v.language,
          durationS: v.actualDurationS,
          costCents: Math.round(v.costCents * 100) / 100,
          outputPath: v.outputPath,
          finishedAt: v.finishedAt ? new Date(v.finishedAt).toISOString() : null,
        }))
      return { videos: items }
    },
  )

  tool(
    'channel_create',
    'Cria um canal (nicho, idioma, voz e preset de estilo) e devolve o channelId.',
    {
      name: z.string().min(1).max(80),
      niche: z.string().min(1).max(200),
      language: z.enum(LANGUAGES),
      tts_provider: z.enum(['elevenlabs', 'openai', 'azure']).optional(),
      voice_id: z.string().min(1).max(120).optional(),
      music_mood: z.enum(MUSIC_MOODS).optional(),
      script_style: z.string().max(500).optional(),
      manual_review: z.boolean().optional().describe('Parar para revisão humana antes da montagem'),
    },
    { readOnlyHint: false, idempotentHint: false },
    (a) => {
      const c = createChannel(h, {
        name: a.name,
        niche: a.niche,
        language: a.language,
        ttsProvider: a.tts_provider,
        voiceId: a.voice_id,
        musicMood: a.music_mood,
        stylePreset: { manualReview: a.manual_review ?? false, ...(a.script_style ? { scriptStyle: a.script_style } : {}) },
      })
      return { channelId: c.id, name: c.name, niche: c.niche, language: c.language }
    },
  )

  tool(
    'cost_estimate',
    'Estima o custo em centavos de dólar de um vídeo antes de gerar, por etapa e provedor configurado.',
    videoInput,
    { readOnlyHint: true },
    async (a) => {
      const e = await estimateVideoCost(h, deps.providers, {
        channelId: a.channel_id,
        theme: a.theme,
        language: a.language,
        durationS: a.duration_s ?? DURATION.defaultS,
      })
      return { totalCents: Math.round(e.totalCents * 100) / 100, breakdown: e.breakdown, missing: e.missing }
    },
  )

  return {
    server,
    runner,
    async close() {
      await runner.stop()
      await server.close()
    },
  }
}
