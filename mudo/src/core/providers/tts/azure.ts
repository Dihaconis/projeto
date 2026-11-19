import { LANGUAGES, type Language } from '../../../shared/enums'
import { ttsCostCents } from '../pricing'
import { ProviderTechnicalError, httpError, networkError, type TtsInput, type TtsOutput, type TtsProvider } from '../types'

export interface AzureTtsOptions {
  apiKey: string
  region: string
  timeoutMs?: number
  baseURL?: string
}

const ID = 'azure'

const DEFAULT_VOICES: Record<Language, string> = {
  'pt-BR': 'pt-BR-FranciscaNeural',
  es: 'es-ES-ElviraNeural',
  en: 'en-US-JennyNeural',
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)
}

/** Azure AI Speech (REST + SSML). */
export function azureTts(o: AzureTtsOptions): TtsProvider {
  if (!/^[a-z0-9]+$/.test(o.region)) throw new Error('região do Azure inválida')
  const base = o.baseURL ?? `https://${o.region}.tts.speech.microsoft.com`
  return {
    id: ID,
    caps: { languages: [...LANGUAGES], maxChars: 5000, wordTimestamps: false },
    estimateCost: (i) => ttsCostCents(ID, i.text.length),
    defaultVoice: (lang) => DEFAULT_VOICES[lang],
    async call(input: TtsInput, signal: AbortSignal): Promise<TtsOutput> {
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${input.language}">` +
        `<voice name="${escapeXml(input.voiceId)}">${escapeXml(input.text)}</voice></speak>`
      let res: Response
      try {
        res = await fetch(`${base}/cognitiveservices/v1`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': o.apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
            'User-Agent': 'MUDO',
          },
          body: ssml,
          signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 90_000)]),
        })
      } catch (err) {
        throw networkError(ID, err, signal)
      }
      if (!res.ok) throw httpError(ID, res.status, await res.text())
      const audio = Buffer.from(await res.arrayBuffer())
      if (audio.length === 0) throw new ProviderTechnicalError(ID, 'azure: áudio vazio', true)
      return { audio, ext: 'mp3', model: 'neural', chars: input.text.length, costCents: ttsCostCents(ID, input.text.length) }
    },
  }
}
