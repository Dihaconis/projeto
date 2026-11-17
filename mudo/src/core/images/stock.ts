import { z } from 'zod'
import type { ImageLicense } from '../../shared/enums'
import { ProviderRefusalError, ProviderTechnicalError, httpError, networkError, type Provider } from '../providers/types'

export interface StockCandidate {
  sourceId: string
  pageUrl: string
  previewUrl: string
  downloadUrl: string
  width: number
  height: number
  author: string
  authorUrl: string | null
  description: string
}

export interface StockQuery {
  query: string
  perPage: number
}

export interface StockResult {
  candidates: StockCandidate[]
  costCents: number
  model: string
}

export type StockProvider = Provider<StockQuery, StockResult> & {
  license: Extract<ImageLicense, 'pexels' | 'pixabay'>
  /** Baixa a imagem (prévia para pontuar, ou a final escolhida). */
  download(url: string, signal: AbortSignal): Promise<Buffer>
  /** Texto de atribuição exigido/recomendado pelos termos do provedor. */
  credit(c: StockCandidate): string
  requiresCredit: boolean
}

/** Janela deslizante de requisições (respeita os limites das APIs, seção 7). */
export class RateLimiter {
  private stamps: number[] = []
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      const t = this.now()
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs)
      if (this.stamps.length < this.limit) {
        this.stamps.push(t)
        return
      }
      const wait = this.windowMs - (t - this.stamps[0]!) + 5
      if (wait > 60_000) {
        // não vale segurar o job: deixa o próximo provedor tentar
        throw new ProviderTechnicalError('ratelimit', 'limite de requisições do banco de imagens atingido nesta hora', false, 429)
      }
      await new Promise<void>((resolve, reject) => {
        const tm = setTimeout(resolve, wait)
        signal.addEventListener('abort', () => (clearTimeout(tm), reject(signal.reason)), { once: true })
      })
    }
  }
}

async function getBuffer(id: string, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  } catch (err) {
    throw networkError(id, err, signal)
  }
  if (!res.ok) throw httpError(id, res.status, '')
  return Buffer.from(await res.arrayBuffer())
}

const pexelsSchema = z.object({
  photos: z.array(
    z.object({
      id: z.number(),
      width: z.number(),
      height: z.number(),
      url: z.string(),
      photographer: z.string(),
      photographer_url: z.string().nullable().optional(),
      alt: z.string().nullable().optional(),
      src: z.object({ original: z.string(), large2x: z.string(), medium: z.string() }),
    }),
  ),
})

/** Pexels: chave no cabeçalho Authorization; 200 req/hora no plano gratuito. */
export function pexels(o: { apiKey: string; baseURL?: string; limiter?: RateLimiter }): StockProvider {
  const base = o.baseURL ?? 'https://api.pexels.com/v1'
  const limiter = o.limiter ?? new RateLimiter(200, 3_600_000)
  return {
    id: 'pexels',
    license: 'pexels',
    requiresCredit: true,
    caps: { languages: ['en'] },
    estimateCost: () => 0,
    credit: (c) => `Foto de ${c.author} no Pexels (${c.pageUrl})`,
    download: (url, signal) => getBuffer('pexels', url, {}, signal),
    async call(q, signal) {
      await limiter.acquire(signal)
      const url = `${base}/search?${new URLSearchParams({ query: q.query, orientation: 'landscape', size: 'large', per_page: String(q.perPage) })}`
      let res: Response
      try {
        res = await fetch(url, { headers: { Authorization: o.apiKey }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
      } catch (err) {
        throw networkError('pexels', err, signal)
      }
      const body = await res.text()
      if (!res.ok) throw httpError('pexels', res.status, body)
      const parsed = pexelsSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError('pexels', 'pexels: resposta em formato inesperado', false)
      return {
        model: 'pexels',
        costCents: 0,
        candidates: parsed.data.photos.map((p) => ({
          sourceId: String(p.id),
          pageUrl: p.url,
          previewUrl: p.src.medium,
          downloadUrl: p.width > 3840 ? p.src.large2x.replace(/w=\d+/, 'w=3840') : p.src.original,
          width: p.width,
          height: p.height,
          author: p.photographer,
          authorUrl: p.photographer_url ?? null,
          description: p.alt ?? '',
        })),
      }
    },
  }
}

const pixabaySchema = z.object({
  hits: z.array(
    z.object({
      id: z.number(),
      pageURL: z.string(),
      tags: z.string(),
      webformatURL: z.string(),
      largeImageURL: z.string(),
      imageWidth: z.number(),
      imageHeight: z.number(),
      user: z.string(),
      user_id: z.number(),
    }),
  ),
})

/** Pixabay: chave na query (exigência da API); 100 req/60 s. */
export function pixabay(o: { apiKey: string; baseURL?: string; limiter?: RateLimiter }): StockProvider {
  const base = o.baseURL ?? 'https://pixabay.com/api/'
  const limiter = o.limiter ?? new RateLimiter(100, 60_000)
  return {
    id: 'pixabay',
    license: 'pixabay',
    requiresCredit: false,
    caps: { languages: ['en'] },
    estimateCost: () => 0,
    credit: (c) => `Imagem de ${c.author} no Pixabay (${c.pageUrl})`,
    download: (url, signal) => getBuffer('pixabay', url, {}, signal),
    async call(q, signal) {
      await limiter.acquire(signal)
      const params = new URLSearchParams({
        key: o.apiKey,
        q: q.query.slice(0, 100),
        image_type: 'photo',
        orientation: 'horizontal',
        min_width: '1280',
        safesearch: 'true',
        per_page: String(Math.max(3, Math.min(200, q.perPage))),
      })
      let res: Response
      try {
        res = await fetch(`${base}?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
      } catch (err) {
        throw networkError('pixabay', err, signal)
      }
      const body = await res.text()
      // a mensagem de erro do Pixabay pode ecoar a URL com a chave: não repassa o corpo
      if (!res.ok) throw httpError('pixabay', res.status, '')
      const parsed = pixabaySchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError('pixabay', 'pixabay: resposta em formato inesperado', false)
      return {
        model: 'pixabay',
        costCents: 0,
        candidates: parsed.data.hits.map((h) => ({
          sourceId: String(h.id),
          pageUrl: h.pageURL,
          previewUrl: h.webformatURL,
          downloadUrl: h.largeImageURL,
          width: h.imageWidth,
          height: h.imageHeight,
          author: h.user,
          authorUrl: `https://pixabay.com/users/${h.user}-${h.user_id}/`,
          description: h.tags,
        })),
      }
    },
  }
}

// ---------- geração por IA (último recurso) ----------

export interface ImageGenInput {
  prompt: string
}
export interface ImageGenOutput {
  image: Buffer
  model: string
  costCents: number
}
export type ImageGenProvider = Provider<ImageGenInput, ImageGenOutput>

const openAiImageSchema = z.object({ data: z.array(z.object({ b64_json: z.string() })).min(1) })

/** OpenAI Images (`gpt-image-1`, 1536×1024). Licença registrada: `generated`. */
export function openAiImages(o: { apiKey: string; model?: string; baseURL?: string }): ImageGenProvider {
  const model = o.model ?? 'gpt-image-1'
  const base = o.baseURL ?? 'https://api.openai.com/v1'
  const cents = 6.3
  return {
    id: 'openai-images',
    caps: { languages: ['en'] },
    estimateCost: () => cents,
    async call(i, signal) {
      let res: Response
      try {
        res = await fetch(`${base}/images/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: i.prompt, size: '1536x1024', n: 1 }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        })
      } catch (err) {
        throw networkError('openai-images', err, signal)
      }
      const body = await res.text()
      if (!res.ok) {
        // bloqueio de política do gerador vem como 400 "moderation_blocked"
        if (res.status === 400 && /moderation|safety/i.test(body)) {
          throw new ProviderRefusalError('openai-images', 'O gerador de imagens recusou a descrição por política de uso.')
        }
        throw httpError('openai-images', res.status, body)
      }
      const parsed = openAiImageSchema.safeParse(JSON.parse(body))
      if (!parsed.success) throw new ProviderTechnicalError('openai-images', 'openai-images: resposta inesperada', false)
      return { image: Buffer.from(parsed.data.data[0]!.b64_json, 'base64'), model, costCents: cents }
    },
  }
}
