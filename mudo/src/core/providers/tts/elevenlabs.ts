import { z } from 'zod'
import { LANGUAGES, type Language } from '../../../shared/enums'
import { ttsCostCents } from '../pricing'
import { ProviderTechnicalError, httpError, networkError, type TtsInput, type TtsOutput, type TtsProvider } from '../types'

export interface ElevenLabsOptions {
  apiKey: string
  model?: string
  timeoutMs?: number
  baseURL?: string
}

const ID = 'elevenlabs'

const alignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
})
const responseSchema = z.object({
  audio_base64: z.string(),
  alignment: alignmentSchema.nullable().optional(),
  normalized_alignment: alignmentSchema.nullable().optional(),
})

const LANGUAGE_CODE: Record<Language, string> = { 'pt-BR': 'pt', es: 'es', en: 'en' }

/** ElevenLabs com o endpoint `/with-timestamps` (timestamps por caractere, seção 7). */
export function elevenLabsTts(o: ElevenLabsOptions): TtsProvider {
  const model = o.model ?? 'eleven_multilingual_v2'
  const base = o.baseURL ?? 'https://api.elevenlabs.io'
  return {
    id: ID,
    caps: { languages: [...LANGUAGES], maxChars: 5000, wordTimestamps: true },
    estimateCost: (i) => ttsCostCents(ID, i.text.length),
    // "Rachel" — voz pré-definida multilíngue da biblioteca da ElevenLabs
    defaultVoice: () => '21m00Tcm4TlvDq8ikWAM',
    async call(input: TtsInput, signal: AbortSignal): Promise<TtsOutput> {
      let res: Response
      try {
        res = await fetch(
          `${base}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': o.apiKey, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text: input.text, model_id: model, language_code: LANGUAGE_CODE[input.language] }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 90_000)]),
          },
        )
      } catch (err) {
        throw networkError(ID, err, signal)
      }
      const body = await res.text()
      if (!res.ok) throw httpError(ID, res.status, body)
      const parsed = responseSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError(ID, 'elevenlabs: resposta em formato inesperado', false)
      const audio = Buffer.from(parsed.data.audio_base64, 'base64')
      if (audio.length === 0) throw new ProviderTechnicalError(ID, 'elevenlabs: áudio vazio', true)
      const a = parsed.data.alignment ?? parsed.data.normalized_alignment
      return {
        audio,
        ext: 'mp3',
        model,
        chars: input.text.length,
        costCents: ttsCostCents(ID, input.text.length),
        ...(a ? { alignment: { chars: a.characters, startS: a.character_start_times_seconds, endS: a.character_end_times_seconds } } : {}),
      }
    },
  }
}
