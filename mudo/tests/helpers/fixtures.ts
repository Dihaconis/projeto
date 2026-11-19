/**
 * Provedores de FIXTURE — existem só em /tests (seção 17, item 11). Devolvem
 * respostas gravadas em tests/fixtures/ no formato real dos provedores, sem
 * rede. Nunca são importados pelo código do produto.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
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
import { normalize, type EmbeddingProvider } from '../../src/core/images/embeddings'
import type { ImageGenProvider, StockCandidate, StockProvider } from '../../src/core/images/stock'

const FIX = path.resolve(__dirname, '../fixtures')
const read = (rel: string) => fs.readFileSync(path.join(FIX, rel), 'utf8')

/**
 * Embeddings de FIXTURE: saco de palavras com hash em 128 dimensões. Só lê
 * texto (como o modelo de texto da OpenAI), então imagens são representadas
 * pela descrição/nome do arquivo. Determinístico e instantâneo.
 */
export const fixtureEmbeddings: EmbeddingProvider = {
  model: 'fixture:bow-128',
  async embedTexts(texts) {
    return texts.map((t) => {
      const v = new Float32Array(128)
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
        const h = createHash('md5').update(w).digest()
        v[h[0]! % 128]! += 1
      }
      v[127] = (v[127] ?? 0) + 0.05 // evita vetor nulo
      return normalize(v)
    })
  },
}

/** Imagem de ruído determinística (pHash distinto por semente). */
export async function noiseImage(seed: string, width: number, height: number): Promise<Buffer> {
  const w = 32
  const h = 18
  const raw = Buffer.alloc(w * h * 3)
  let x = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    raw[i] = (x >>> 0) & 0xff
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).resize(width, height, { kernel: 'nearest' }).jpeg({ quality: 85 }).toBuffer()
}

/** Banco de imagens de FIXTURE: candidatos com descrição = busca; imagens geradas localmente. */
export function fixtureStock(id: 'pexels' | 'pixabay' = 'pexels', log?: { searches: string[]; downloads: string[] }): StockProvider {
  let counter = 0
  return {
    id,
    license: id,
    requiresCredit: id === 'pexels',
    caps: { languages: ['en'] },
    estimateCost: () => 0,
    credit: (c: StockCandidate) => `Foto de ${c.author} no ${id === 'pexels' ? 'Pexels' : 'Pixabay'} (${c.pageUrl})`,
    async download(url) {
      log?.downloads.push(url)
      const [, sid, kind] = /^fixture:\/\/([^/]+)\/(preview|full)$/.exec(url) ?? []
      if (!sid) throw new Error(`url de fixture inválida: ${url}`)
      return kind === 'full' ? noiseImage(sid, 1920, 1080) : noiseImage(sid, 400, 225)
    },
    async call(q) {
      log?.searches.push(q.query)
      const base = counter++
      return {
        model: 'fixture',
        costCents: 0,
        candidates: Array.from({ length: 4 }, (_, i) => {
          const sid = `${id}-${base}-${i}`
          return {
            sourceId: sid,
            pageUrl: `https://example.invalid/${id}/${sid}`,
            previewUrl: `fixture://${sid}/preview`,
            downloadUrl: `fixture://${sid}/full`,
            width: i === 3 ? 1000 : 1920, // uma estreita demais, deve ser ignorada
            height: i === 3 ? 600 : 1080,
            author: `Autor ${sid}`,
            authorUrl: null,
            description: q.query,
          }
        }),
      }
    },
  }
}

/** Gerador de imagens de FIXTURE (último recurso). */
export function fixtureImageGen(log?: string[]): ImageGenProvider {
  let n = 0
  return {
    id: 'fixture-gen',
    caps: { languages: ['en'] },
    estimateCost: () => 5,
    async call(i) {
      log?.push(i.prompt)
      return { image: await noiseImage(`gen-${n++}-${i.prompt}`, 1536, 1024), model: 'fixture', costCents: 5 }
    },
  }
}

/** Nenhum provedor configurado (testes de fila que não chamam modelos). */
export const noProviders: ProviderSource = {
  llm: async () => [],
  tts: async () => [],
  stock: async () => [],
  imageGen: async () => [],
  embeddings: async () => fixtureEmbeddings,
}

export interface FixtureLog {
  calls: Array<{ provider: string; kind: 'script' | 'review' | 'scenes' | 'tts' | 'cuts'; at: number }>
}

function kindOf(i: LlmInput): 'script' | 'review' | 'scenes' | 'cuts' {
  if (i.system.includes('short-form clips')) return 'cuts'
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
      if (kind === 'cuts') {
        // escolhe frases seguidas até dar ~20 s, como um editor faria, a partir das linhas "[a–b] texto"
        const lines = [...input.prompt.matchAll(/^\[([\d.]+)–([\d.]+)\] (.+)$/gm)].map((m) => ({ a: Number(m[1]), b: Number(m[2]), t: m[3]! }))
        const hls: Array<{ start_s: number; end_s: number; score: number; title: string; reason: string }> = []
        let i = 0
        while (i < lines.length && hls.length < 2) {
          const start = lines[i]!.a
          let j = i
          while (j < lines.length - 1 && lines[j]!.b - start < 18) j++
          if (lines[j]!.b - start >= 15) hls.push({ start_s: start, end_s: lines[j]!.b, score: 90 - hls.length * 15, title: `Trecho ${hls.length + 1}`, reason: 'Abre com uma frase forte e fecha a ideia.' })
          i = j + 1
        }
        text = JSON.stringify({ highlights: hls.length ? hls : [{ start_s: 0, end_s: 5, score: 10, title: 'Curto', reason: 'curto demais' }] })
      } else if (kind === 'script') text = read(opts.script ?? 'llm/script-ceu-azul-pt-60s.json')
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

/** Silêncio nas pontas do áudio de fixture (o pipeline precisa cortar e descontar). */
export const FIXTURE_LEAD_MS = 250
export const FIXTURE_TAIL_MS = 150

/**
 * WAV PCM 24 kHz mono: silêncio, um tom modulado com duração proporcional ao
 * texto (~150 ppm) e silêncio. Devolve também o alinhamento por caractere
 * (como o endpoint com timestamps da ElevenLabs), em segundos.
 */
export function speechLikeWav(text: string, wpm = 150): { wav: Buffer; alignment: { chars: string[]; startS: number[]; endS: number[] } } {
  const rate = 24_000
  const words = text.trim().split(/\s+/).length
  const speechS = (words / wpm) * 60
  const lead = FIXTURE_LEAD_MS / 1000
  const total = lead + speechS + FIXTURE_TAIL_MS / 1000
  const n = Math.round(total * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    if (t < lead || t > lead + speechS) continue
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * (t - lead))
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
  const chars = [...text]
  const dt = speechS / chars.length
  return {
    wav: Buffer.concat([h, data]),
    alignment: { chars, startS: chars.map((_, i) => lead + i * dt), endS: chars.map((_, i) => lead + (i + 1) * dt) },
  }
}

export function fixtureTts(id = 'fixture-tts', log?: FixtureLog, opts: { wpm?: number; onCall?: () => void; noAlignment?: boolean } = {}): TtsProvider {
  return {
    id,
    caps: { languages: ['pt-BR', 'es', 'en'], wordTimestamps: false },
    estimateCost: (i) => i.text.length / 1000,
    defaultVoice: () => 'fixture-voice',
    async call(input: TtsInput, signal: AbortSignal): Promise<TtsOutput> {
      if (signal.aborted) throw signal.reason
      log?.calls.push({ provider: id, kind: 'tts', at: Date.now() })
      opts.onCall?.()
      const { wav, alignment } = speechLikeWav(input.text, opts.wpm)
      return { audio: wav, ext: 'wav', model: 'fixture', chars: input.text.length, costCents: input.text.length / 1000, ...(opts.noAlignment ? {} : { alignment }) }
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

export function fixtureSource(
  llm: LlmProvider[],
  tts: TtsProvider[],
  images: { stock?: StockProvider[]; gen?: ImageGenProvider[]; embeddings?: EmbeddingProvider } = {},
): ProviderSource {
  const stock = images.stock ?? [fixtureStock('pexels')]
  return {
    llm: async () => llm,
    tts: async () => tts,
    stock: async () => stock,
    imageGen: async () => images.gen ?? [],
    embeddings: async () => images.embeddings ?? fixtureEmbeddings,
  }
}
