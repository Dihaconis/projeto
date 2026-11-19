import { z } from 'zod'
import { LANGUAGES } from '../../../shared/enums'
import { approxTokens, llmCostCents } from '../pricing'
import { ProviderRefusalError, ProviderTechnicalError, httpError, networkError, type LlmInput, type LlmOutput, type LlmProvider } from '../types'

export interface OpenAiLlmOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  baseURL?: string
}

const ID = 'openai'

const responseSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
})

/** OpenAI Chat Completions com `response_format: json_schema`. */
export function openAiLlm(o: OpenAiLlmOptions): LlmProvider {
  const model = o.model ?? 'gpt-5'
  const base = o.baseURL ?? 'https://api.openai.com/v1'
  return {
    id: ID,
    caps: { languages: [...LANGUAGES] },
    estimateCost: (i) => llmCostCents(model, approxTokens(i.system + i.prompt), i.expectedOutputTokens * 2),
    async call(input: LlmInput, signal: AbortSignal): Promise<LlmOutput> {
      let res: Response
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.prompt },
            ],
            response_format: { type: 'json_schema', json_schema: { name: 'mudo_output', schema: input.jsonSchema, strict: false } },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 180_000)]),
        })
      } catch (err) {
        throw networkError(ID, err, signal)
      }
      const body = await res.text()
      if (!res.ok) throw httpError(ID, res.status, body)
      const parsed = responseSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError(ID, 'openai: resposta em formato inesperado', false)
      const choice = parsed.data.choices[0]!
      if (choice.message.refusal) throw new ProviderRefusalError(ID, choice.message.refusal)
      if (choice.finish_reason === 'content_filter') {
        throw new ProviderRefusalError(ID, 'O provedor bloqueou a resposta pelo filtro de conteúdo.')
      }
      if (choice.finish_reason === 'length') throw new ProviderTechnicalError(ID, 'openai: resposta cortada por limite de tokens', false)
      const { prompt_tokens: tokensIn, completion_tokens: tokensOut } = parsed.data.usage
      return {
        text: choice.message.content ?? '',
        model: parsed.data.model,
        tokensIn,
        tokensOut,
        costCents: llmCostCents(model, tokensIn, tokensOut),
      }
    },
  }
}
