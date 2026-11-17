import { z } from 'zod'
import { LANGUAGES } from '../../../shared/enums'
import { approxTokens, llmCostCents } from '../pricing'
import { ProviderRefusalError, ProviderTechnicalError, httpError, networkError, type LlmInput, type LlmOutput, type LlmProvider } from '../types'

export interface GeminiOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  baseURL?: string
}

const ID = 'gemini'
const BLOCK_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'])

const responseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(),
      }),
    )
    .optional(),
  usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional(),
  modelVersion: z.string().optional(),
})

/** Gemini `generateContent` com saída JSON. Chave no cabeçalho, nunca na URL. */
export function geminiLlm(o: GeminiOptions): LlmProvider {
  const model = o.model ?? 'gemini-2.5-pro'
  const base = o.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta'
  return {
    id: ID,
    caps: { languages: [...LANGUAGES] },
    estimateCost: (i) => llmCostCents(model, approxTokens(i.system + i.prompt), i.expectedOutputTokens * 2),
    async call(input: LlmInput, signal: AbortSignal): Promise<LlmOutput> {
      let res: Response
      try {
        res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': o.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 180_000)]),
        })
      } catch (err) {
        throw networkError(ID, err, signal)
      }
      const body = await res.text()
      if (!res.ok) throw httpError(ID, res.status, body)
      const parsed = responseSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError(ID, 'gemini: resposta em formato inesperado', false)
      const d = parsed.data
      const block = d.promptFeedback?.blockReason
      if (block) throw new ProviderRefusalError(ID, `O provedor bloqueou o pedido (${block}).`, block)
      const cand = d.candidates?.[0]
      if (!cand) throw new ProviderTechnicalError(ID, 'gemini: resposta sem candidatos', true)
      if (cand.finishReason && BLOCK_REASONS.has(cand.finishReason)) {
        throw new ProviderRefusalError(ID, `O provedor bloqueou a resposta (${cand.finishReason}).`, cand.finishReason)
      }
      if (cand.finishReason === 'MAX_TOKENS') throw new ProviderTechnicalError(ID, 'gemini: resposta cortada por limite de tokens', false)
      const text = (cand.content?.parts ?? []).map((p) => p.text ?? '').join('')
      const tokensIn = d.usageMetadata?.promptTokenCount ?? 0
      const tokensOut = d.usageMetadata?.candidatesTokenCount ?? 0
      return { text, model: d.modelVersion ?? model, tokensIn, tokensOut, costCents: llmCostCents(model, tokensIn, tokensOut) }
    },
  }
}
