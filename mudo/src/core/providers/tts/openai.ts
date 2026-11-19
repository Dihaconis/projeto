import { LANGUAGES } from '../../../shared/enums'
import { ttsCostCents } from '../pricing'
import { ProviderTechnicalError, httpError, networkError, type TtsInput, type TtsOutput, type TtsProvider } from '../types'

export interface OpenAiTtsOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  baseURL?: string
}

const ID = 'openai'

/** OpenAI `/audio/speech`. Sem timestamps: o alinhamento vem do whisper.cpp. */
export function openAiTts(o: OpenAiTtsOptions): TtsProvider {
  const model = o.model ?? 'gpt-4o-mini-tts'
  const base = o.baseURL ?? 'https://api.openai.com/v1'
  return {
    id: ID,
    caps: { languages: [...LANGUAGES], maxChars: 4096, wordTimestamps: false },
    estimateCost: (i) => ttsCostCents(ID, i.text.length),
    defaultVoice: () => 'alloy',
    async call(input: TtsInput, signal: AbortSignal): Promise<TtsOutput> {
      let res: Response
      try {
        res = await fetch(`${base}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, voice: input.voiceId, input: input.text, response_format: 'mp3' }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 90_000)]),
        })
      } catch (err) {
        throw networkError(ID, err, signal)
      }
      if (!res.ok) throw httpError(ID, res.status, await res.text())
      const audio = Buffer.from(await res.arrayBuffer())
      if (audio.length === 0) throw new ProviderTechnicalError(ID, 'openai: áudio vazio', true)
      return { audio, ext: 'mp3', model, chars: input.text.length, costCents: ttsCostCents(ID, input.text.length) }
    },
  }
}
