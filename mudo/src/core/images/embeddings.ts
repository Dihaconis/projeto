import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ProviderTechnicalError, httpError, networkError } from '../providers/types'

/**
 * Embeddings para casar a busca visual de cada cena com imagens (seção 7).
 * `embedImage` ausente = o modelo só lê texto; aí a imagem é representada pela
 * própria descrição/tags.
 */
export interface EmbeddingProvider {
  /** Identifica o espaço vetorial; vetores de modelos diferentes nunca se comparam. */
  readonly model: string
  embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  embedImage?(input: string | Buffer, signal?: AbortSignal): Promise<Float32Array>
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n
  return out
}

/** Cosseno entre vetores já normalizados. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

export function blobToVec(b: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!b || b.byteLength % 4 !== 0) return null
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return new Float32Array(copy.buffer)
}

export const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32'

/**
 * CLIP local, offline (padrão): o modelo vem em `resources/models` com hash
 * verificado no build (`scripts/fetch-models.mjs`). Nada é baixado em execução.
 */
export function clipLocal(modelsDir: string): EmbeddingProvider {
  type Loaded = {
    tok: (t: string[], o: object) => unknown
    text: (i: unknown) => Promise<{ text_embeds: { tolist(): number[][] } }>
    proc: (img: unknown) => Promise<unknown>
    vision: (i: unknown) => Promise<{ image_embeds: { data: Float32Array } }>
    RawImage: { fromBlob(b: Blob): Promise<unknown> }
  }
  let loading: Promise<Loaded> | null = null
  const load = () => {
    loading ??= (async () => {
      if (!fs.existsSync(path.join(modelsDir, CLIP_MODEL_ID, 'onnx', 'vision_model_quantized.onnx'))) {
        throw new Error(`modelo CLIP ausente em ${modelsDir} (rode "npm run models" ou reinstale o app)`)
      }
      const t = await import('@huggingface/transformers')
      t.env.allowRemoteModels = false
      t.env.allowLocalModels = true
      t.env.localModelPath = modelsDir.endsWith(path.sep) ? modelsDir : modelsDir + path.sep
      const [tok, text, proc, vision] = await Promise.all([
        t.AutoTokenizer.from_pretrained(CLIP_MODEL_ID),
        t.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
        t.AutoProcessor.from_pretrained(CLIP_MODEL_ID),
        t.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL_ID, { dtype: 'q8' }),
      ])
      return {
        tok: tok as unknown as Loaded['tok'],
        text: text as unknown as Loaded['text'],
        proc: proc as unknown as Loaded['proc'],
        vision: vision as unknown as Loaded['vision'],
        RawImage: t.RawImage as unknown as Loaded['RawImage'],
      }
    })()
    return loading
  }
  return {
    model: `clip:${CLIP_MODEL_ID}:q8`,
    async embedTexts(texts) {
      if (texts.length === 0) return []
      const m = await load()
      const out: Float32Array[] = []
      for (let i = 0; i < texts.length; i += 32) {
        const batch = texts.slice(i, i + 32)
        const { text_embeds } = await m.text(m.tok(batch, { padding: true, truncation: true }))
        for (const row of text_embeds.tolist()) out.push(normalize(Float32Array.from(row)))
      }
      return out
    },
    async embedImage(input) {
      const m = await load()
      const buf = typeof input === 'string' ? fs.readFileSync(input) : input
      const img = await m.RawImage.fromBlob(new Blob([new Uint8Array(buf)]))
      const { image_embeds } = await m.vision(await m.proc(img))
      return normalize(Float32Array.from(image_embeds.data))
    },
  }
}

const openAiEmbeddingSchema = z.object({ data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })) })

/** OpenAI (só texto): imagens são representadas pela descrição/tags. */
export function openAiEmbeddings(o: { apiKey: string; model?: string; baseURL?: string }): EmbeddingProvider {
  const model = o.model ?? 'text-embedding-3-small'
  const base = o.baseURL ?? 'https://api.openai.com/v1'
  return {
    model: `openai:${model}`,
    async embedTexts(texts, signal) {
      if (texts.length === 0) return []
      const s = signal ?? new AbortController().signal
      let res: Response
      try {
        res = await fetch(`${base}/embeddings`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.any([s, AbortSignal.timeout(60_000)]),
        })
      } catch (err) {
        throw networkError('openai', err, s)
      }
      const body = await res.text()
      if (!res.ok) throw httpError('openai', res.status, body)
      const parsed = openAiEmbeddingSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError('openai', 'openai: resposta de embeddings inesperada', false)
      return parsed.data.data.sort((a, b) => a.index - b.index).map((d) => normalize(Float32Array.from(d.embedding)))
    },
  }
}
