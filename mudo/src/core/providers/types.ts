import type { Language } from '../../shared/enums'

/** Interface única de provedor (seção 7). */
export interface Provider<TIn, TOut> {
  id: string
  caps: { languages: string[]; maxChars?: number; wordTimestamps?: boolean }
  /** Custo estimado em centavos de dólar. */
  estimateCost(input: TIn): number
  call(input: TIn, signal: AbortSignal): Promise<TOut>
}

export type ProviderKind = 'llm' | 'tts'

// ---------- LLM ----------

export interface LlmInput {
  system: string
  prompt: string
  /** JSON Schema (subconjunto simples) da resposta esperada. A validação final é sempre zod. */
  jsonSchema: Record<string, unknown>
  /** Estimativa de tokens de saída, para custo e max_tokens. */
  expectedOutputTokens: number
}

export interface LlmOutput {
  text: string
  model: string
  tokensIn: number
  tokensOut: number
  costCents: number
}

export type LlmProvider = Provider<LlmInput, LlmOutput>

// ---------- TTS ----------

export interface TtsInput {
  text: string
  voiceId: string
  language: Language
}

export interface CharAlignment {
  chars: string[]
  startS: number[]
  endS: number[]
}

export interface TtsOutput {
  audio: Buffer
  /** Extensão do áudio retornado (ffmpeg detecta o formato pelo conteúdo). */
  ext: 'mp3' | 'wav'
  model: string
  chars: number
  costCents: number
  /** Timestamps por caractere quando o provedor oferece (ElevenLabs). */
  alignment?: CharAlignment
}

export type TtsProvider = Provider<TtsInput, TtsOutput> & {
  /** Voz padrão do provedor para um idioma (usada quando o canal não define). */
  defaultVoice(language: Language): string
}

// ---------- erros ----------

/**
 * Falha técnica: timeout, 5xx, rate limit, cota da API, rede, chave inválida.
 * `retryable` = vale tentar de novo no MESMO provedor; com ou sem retry,
 * esgotadas as tentativas o próximo provedor da ordem é usado (seção 7).
 */
export class ProviderTechnicalError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly outcome: 'error' | 'timeout' = 'error',
  ) {
    super(message)
    this.name = 'ProviderTechnicalError'
  }
}

/**
 * Recusa por política do provedor. NUNCA dispara troca automática de
 * provedor: o job vai para `needs_input` com a mensagem (seção 7).
 */
export class ProviderRefusalError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly category?: string | null,
  ) {
    super(message)
    this.name = 'ProviderRefusalError'
  }
}

/** Classifica um status HTTP de erro. */
export function httpError(providerId: string, status: number, body: string): ProviderTechnicalError {
  const short = body.replace(/\s+/g, ' ').slice(0, 300)
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500
  const what =
    status === 401 || status === 403
      ? 'chave inválida ou sem permissão'
      : status === 429
        ? 'limite de requisições ou cota da API'
        : status >= 500
          ? 'erro no servidor do provedor'
          : 'requisição rejeitada'
  return new ProviderTechnicalError(providerId, `${providerId}: ${what} (HTTP ${status}) ${short}`.trim(), retryable, status)
}

/** Converte erro de rede/abort do fetch em erro técnico (o abort do usuário é repassado). */
export function networkError(providerId: string, err: unknown, userSignal: AbortSignal): unknown {
  if (userSignal.aborted) return userSignal.reason
  if (err instanceof ProviderTechnicalError || err instanceof ProviderRefusalError) return err
  const e = err as { name?: string; message?: string }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new ProviderTechnicalError(providerId, `${providerId}: tempo esgotado`, true, undefined, 'timeout')
  }
  return new ProviderTechnicalError(providerId, `${providerId}: falha de rede (${e?.message ?? String(err)})`, true)
}

/** Remove cercas ```json ... ``` se o modelo as incluir. */
export function stripJsonFences(text: string): string {
  const t = text.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  return m ? (m[1] ?? '') : t
}
