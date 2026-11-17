/**
 * Provedores de FIXTURE — existem só em /tests (seção 17, item 11). Devolvem
 * respostas gravadas em tests/fixtures/ no formato real dos provedores, sem
 * rede. Nunca são importados pelo código do produto.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ProviderRefusalError,
  ProviderTechnicalError,
  type LlmInput,
  type LlmOutput,
  type LlmProvider,
  type ProviderSource,
  type TtsInput,
  type TtsOutput,
  type TtsProvider,
} from '../../src/core'

const FIX = path.resolve(__dirname, '../fixtures')
const read = (rel: string) => fs.readFileSync(path.join(FIX, rel), 'utf8')

/** Nenhum provedor configurado (testes de fila que não chamam modelos). */
export const noProviders: ProviderSource = { llm: async () => [], tts: async () => [] }

export interface FixtureLog {
  calls: Array<{ provider: string; kind: 'script' | 'review' | 'scenes' | 'tts'; at: number }>
}

function kindOf(i: LlmInput): 'script' | 'review' | 'scenes' {
  if (i.system.includes('stock photos')) return 'scenes'
  if (i.prompt.includes('Rubric')) return 'review'
  return 'script'
}

/** LLM de fixture: roteiro e revisão gravados; buscas de imagem derivadas das cenas do prompt. */
export function fixtureLlm(id = 'fixture-llm', log?: FixtureLog, opts: { script?: string; review?: string } = {}): LlmProvider {
  return {
    id,
    caps: { languages: ['pt-BR', 'es', 'en'] },
    estimateCost: () => 1,
    async call(input: LlmInput, signal: AbortSignal): Promise<LlmOutput> {
      if (signal.aborted) throw signal.reason
      const kind = kindOf(input)
      log?.calls.push({ provider: id, kind, at: Date.now() })
      let text: string
      if (kind === 'script') text = read(opts.script ?? 'llm/script-ceu-azul-pt-60s.json')
      else if (kind === 'review') text = read(opts.review ?? 'llm/review-approved.json')
      else {
        const scenes = [...input.prompt.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => Number(m[1]))
        const subjects = ['clear blue sky over a field', 'sunlight through clouds', 'prism splitting white light', 'ocean waves at sea', 'sunset over city skyline', 'person looking up at sky']
        text = JSON.stringify({ scenes: scenes.map((n) => ({ n, image_query: subjects[n % subjects.length] })) })
      }
      return { text, model: 'fixture', tokensIn: Math.ceil(input.prompt.length / 4), tokensOut: Math.ceil(text.length / 4), costCents: 0.5 }
    },
  }
}

/** WAV PCM 24 kHz mono com um tom modulado — duração proporcional ao texto (~150 ppm). */
export function speechLikeWav(text: string, wpm = 150): Buffer {
  const rate = 24_000
  const words = text.trim().split(/\s+/).length
  const seconds = (words / wpm) * 60
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)
    const v = Math.sin(2 * Math.PI * 180 * t) * 0.4 * env + Math.sin(2 * Math.PI * 360 * t) * 0.1
    data.writeInt16LE(Math.round(v * 32767 * 0.8), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export function fixtureTts(id = 'fixture-tts', log?: FixtureLog, opts: { wpm?: number; onCall?: () => void } = {}): TtsProvider {
  return {
    id,
    caps: { languages: ['pt-BR', 'es', 'en'], wordTimestamps: false },
    estimateCost: (i) => i.text.length / 1000,
    defaultVoice: () => 'fixture-voice',
    async call(input: TtsInput, signal: AbortSignal): Promise<TtsOutput> {
      if (signal.aborted) throw signal.reason
      log?.calls.push({ provider: id, kind: 'tts', at: Date.now() })
      opts.onCall?.()
      return { audio: speechLikeWav(input.text, opts.wpm), ext: 'wav', model: 'fixture', chars: input.text.length, costCents: input.text.length / 1000 }
    },
  }
}

/** Provedor "fora do ar": sempre HTTP 503 (critério de aceite 5). */
export function downLlm(id = 'down-llm', log?: FixtureLog): LlmProvider {
  return {
    id,
    caps: { languages: ['pt-BR', 'es', 'en'] },
    estimateCost: () => 1,
    async call() {
      log?.calls.push({ provider: id, kind: 'script', at: Date.now() })
      throw new ProviderTechnicalError(id, `${id}: erro no servidor do provedor (HTTP 503)`, true, 503)
    },
  }
}

/** Provedor que recusa por política (critério de aceite 6). */
export function refusingLlm(id = 'refusing-llm', log?: FixtureLog): LlmProvider {
  return {
    id,
    caps: { languages: ['pt-BR', 'es', 'en'] },
    estimateCost: () => 1,
    async call() {
      log?.calls.push({ provider: id, kind: 'script', at: Date.now() })
      throw new ProviderRefusalError(id, 'O pedido viola a política de uso do provedor.', 'general_harms')
    },
  }
}

export function fixtureSource(llm: LlmProvider[], tts: TtsProvider[]): ProviderSource {
  return { llm: async () => llm, tts: async () => tts }
}
