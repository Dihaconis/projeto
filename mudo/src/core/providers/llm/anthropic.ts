import Anthropic from '@anthropic-ai/sdk'
import { LANGUAGES } from '../../../shared/enums'
import { approxTokens, llmCostCents } from '../pricing'
import {
  ProviderRefusalError,
  ProviderTechnicalError,
  networkError,
  type LlmInput,
  type LlmOutput,
  type LlmProvider,
} from '../types'

export interface AnthropicOptions {
  apiKey: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  timeoutMs?: number
  baseURL?: string
}

const ID = 'anthropic'

/**
 * Claude via SDK oficial. Retries ficam na política comum (call.ts), então o
 * SDK roda com `maxRetries: 0`. Recusa (`stop_reason: "refusal"`) vira
 * ProviderRefusalError — sem fallback de modelo no servidor, de propósito.
 */
export function anthropicLlm(o: AnthropicOptions): LlmProvider {
  const model = o.model ?? 'claude-opus-5-5'
  const client = new Anthropic({
    apiKey: o.apiKey,
    maxRetries: 0,
    timeout: o.timeoutMs ?? 180_000,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
  })
  return {
    id: ID,
    caps: { languages: [...LANGUAGES] },
    estimateCost: (i: LlmInput) => llmCostCents(model, approxTokens(i.system + i.prompt), i.expectedOutputTokens * 2),
    async call(input: LlmInput, signal: AbortSignal): Promise<LlmOutput> {
      let res: Anthropic.Message
      try {
        res = await client.messages.create(
          {
            model,
            max_tokens: 16000,
            system: input.system,
            messages: [{ role: 'user', content: input.prompt }],
            output_config: {
              effort: o.effort ?? 'medium',
              format: { type: 'json_schema', schema: input.jsonSchema },
            },
          },
          { signal },
        )
      } catch (err) {
        if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
          const s = err.status
          const retryable = s === 408 || s === 409 || s === 429 || s >= 500
          throw new ProviderTechnicalError(ID, `anthropic: HTTP ${s} ${err.message}`.slice(0, 400), retryable, s)
        }
        if (err instanceof Anthropic.APIConnectionTimeoutError) {
          throw new ProviderTechnicalError(ID, 'anthropic: tempo esgotado', true, undefined, 'timeout')
        }
        throw networkError(ID, err, signal)
      }
      if (res.stop_reason === 'refusal') {
        const d = res.stop_details
        throw new ProviderRefusalError(
          ID,
          d?.explanation ?? 'O provedor recusou o pedido por política de uso.',
          d?.category ?? null,
        )
      }
      if (res.stop_reason === 'max_tokens') {
        throw new ProviderTechnicalError(ID, 'anthropic: resposta cortada por max_tokens', false)
      }
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      const tokensIn = res.usage.input_tokens
      const tokensOut = res.usage.output_tokens
      return { text, model: res.model, tokensIn, tokensOut, costCents: llmCostCents(model, tokensIn, tokensOut) }
    },
  }
}
