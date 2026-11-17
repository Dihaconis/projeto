import type { Logger } from 'pino'
import type { DbHandle } from '../db'
import { providerLog } from '../db/schema'
import { JobError, NeedsInputError } from '../queue/errors'
import { ProviderRefusalError, ProviderTechnicalError, type Provider } from './types'

export interface CallPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_POLICY: CallPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 15_000 }

export interface CallContext {
  db: DbHandle
  log: Logger
  signal: AbortSignal
  stage: string
  videoId: string | null
  policy?: CallPolicy
  /** Espera injetável (testes). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface CallResult<TOut> {
  output: TOut
  providerId: string
}

/** Backoff exponencial com jitter "full": aleatório entre 50% e 100% do teto. */
export function backoffMs(attempt: number, p: CallPolicy, rand = Math.random): number {
  const cap = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(cap * (0.5 + rand() * 0.5))
}

export const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

type Meter = { model?: string; tokensIn?: number; tokensOut?: number; chars?: number; costCents?: number }

/**
 * Chama provedores na ordem configurada (seção 7):
 * - erro técnico → até `maxAttempts` no mesmo provedor (se retentável), depois o próximo;
 * - recusa por política → `needs_input` com a mensagem, SEM tentar outro provedor;
 * - todos falharam → `PROVIDER_UNAVAILABLE` (job pode ser retomado depois).
 * Toda tentativa vai para `provider_log`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProvider = Provider<any, Meter>
type InOf<P> = P extends Provider<infer I, Meter> ? I : never
type OutOf<P> = P extends Provider<unknown, infer O> ? O : never

export async function callWithFallback<P extends AnyProvider>(
  providers: ReadonlyArray<P>,
  inputFor: (p: P) => InOf<P>,
  ctx: CallContext,
): Promise<CallResult<OutOf<P>>> {
  if (providers.length === 0) {
    throw new NeedsInputError(
      'MISSING_KEY',
      `Nenhum provedor configurado para a etapa "${ctx.stage}". Adicione uma chave de API em Configurações (ou "mudo keys set") e retome o vídeo.`,
    )
  }
  const policy = ctx.policy ?? DEFAULT_POLICY
  const sleep = ctx.sleep ?? abortableSleep
  const failures: string[] = []

  for (const p of providers) {
    const input = inputFor(p)
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      const started = Date.now()
      try {
        const output = (await p.call(input, ctx.signal)) as OutOf<P>
        record(ctx, p.id, 'ok', Date.now() - started, output as Meter)
        return { output, providerId: p.id }
      } catch (err) {
        const latency = Date.now() - started
        if (ctx.signal.aborted) throw ctx.signal.reason
        if (err instanceof ProviderRefusalError) {
          record(ctx, p.id, 'refusal', latency, {})
          ctx.log.warn({ provider: p.id, stage: ctx.stage, category: err.category }, 'recusa por política do provedor')
          throw new NeedsInputError(
            'PROVIDER_REFUSAL',
            `${p.id} recusou o pedido na etapa "${ctx.stage}": ${err.message} Edite o tema/roteiro ou escolha outro provedor e retome.`,
            { provider: p.id, category: err.category ?? null },
          )
        }
        const tech =
          err instanceof ProviderTechnicalError
            ? err
            : new ProviderTechnicalError(p.id, `${p.id}: ${err instanceof Error ? err.message : String(err)}`, false)
        record(ctx, p.id, tech.outcome, latency, {})
        ctx.log.warn({ provider: p.id, stage: ctx.stage, attempt, status: tech.status, retryable: tech.retryable, msg: tech.message }, 'falha técnica do provedor')
        if (!tech.retryable || attempt === policy.maxAttempts) {
          failures.push(tech.message)
          break
        }
        await sleep(backoffMs(attempt, policy), ctx.signal)
      }
    }
  }
  throw new JobError(
    'PROVIDER_UNAVAILABLE',
    `Nenhum provedor respondeu na etapa "${ctx.stage}": ${failures.join(' | ')}`,
    true,
  )
}

function record(ctx: CallContext, provider: string, outcome: 'ok' | 'error' | 'refusal' | 'timeout', latencyMs: number, m: Meter) {
  try {
    ctx.db.db
      .insert(providerLog)
      .values({
        provider,
        model: m.model ?? null,
        stage: ctx.stage,
        videoId: ctx.videoId,
        outcome,
        tokensIn: m.tokensIn ?? null,
        tokensOut: m.tokensOut ?? null,
        chars: m.chars ?? null,
        costCents: Math.round(m.costCents ?? 0),
        latencyMs,
        createdAt: Date.now(),
      })
      .run()
  } catch (err) {
    ctx.log.error({ err }, 'falha ao gravar provider_log')
  }
}
