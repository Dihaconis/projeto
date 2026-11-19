import { z } from 'zod'
import type { DbHandle } from '../db'
import { clipLocal, openAiEmbeddings, type EmbeddingProvider } from '../images/embeddings'
import { openAiImages, pexels, pixabay, type ImageGenProvider, type StockProvider } from '../images/stock'
import type { SecretStore } from '../secrets'
import { getSetting } from '../settings'
import { anthropicLlm } from './llm/anthropic'
import { geminiLlm } from './llm/gemini'
import { openAiLlm } from './llm/openai'
import { azureTts } from './tts/azure'
import { elevenLabsTts } from './tts/elevenlabs'
import { openAiTts } from './tts/openai'
import type { LlmProvider, TtsProvider } from './types'

export const LLM_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const
export const TTS_PROVIDER_IDS = ['elevenlabs', 'openai', 'azure'] as const
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number]

export const PROVIDER_SETTINGS = {
  llmOrder: 'providers.llm.order',
  ttsOrder: 'providers.tts.order',
  anthropicModel: 'providers.anthropic.model',
  anthropicEffort: 'providers.anthropic.effort',
  openaiLlmModel: 'providers.openai.llmModel',
  openaiTtsModel: 'providers.openai.ttsModel',
  geminiModel: 'providers.gemini.model',
  elevenlabsModel: 'providers.elevenlabs.model',
  azureRegion: 'providers.azure.region',
  stockOrder: 'providers.images.order',
  imageGenEnabled: 'providers.images.generate',
  openaiImageModel: 'providers.openai.imageModel',
  embeddings: 'embeddings.provider',
} as const

/** De onde o pipeline obtém provedores (no app: chaves reais; nos testes: fixtures). */
export interface ProviderSource {
  llm(): Promise<LlmProvider[]>
  tts(): Promise<TtsProvider[]>
  /** Bancos de imagem na ordem configurada (Pexels → Pixabay). */
  stock(): Promise<StockProvider[]>
  /** Geração por IA, último recurso (seção 8.4). */
  imageGen(): Promise<ImageGenProvider[]>
  embeddings(): Promise<EmbeddingProvider>
}

export const STOCK_PROVIDER_IDS = ['pexels', 'pixabay'] as const

const str = z.string().min(1).max(200)

/** Um CLIP por pasta de modelos por processo: carregar o modelo é caro. */
const clipCache = new Map<string, EmbeddingProvider>()

export interface ConfiguredProvidersOptions {
  /** Pasta com os modelos locais (resources/models). */
  modelsDir: string
}

/** Monta os provedores na ordem configurada, pulando os que não têm chave. */
export function configuredProviders(h: DbHandle, secrets: SecretStore, opts: ConfiguredProvidersOptions): ProviderSource {
  return {
    async stock() {
      const order = getSetting(h, PROVIDER_SETTINGS.stockOrder, z.array(z.enum(STOCK_PROVIDER_IDS)), [...STOCK_PROVIDER_IDS])
      const out: StockProvider[] = []
      for (const id of order) {
        const key = await secrets.get(id)
        if (key) out.push(id === 'pexels' ? pexels({ apiKey: key }) : pixabay({ apiKey: key }))
      }
      return out
    },
    async imageGen() {
      if (!getSetting(h, PROVIDER_SETTINGS.imageGenEnabled, z.boolean(), true)) return []
      const key = await secrets.get('openai')
      return key ? [openAiImages({ apiKey: key, model: getSetting(h, PROVIDER_SETTINGS.openaiImageModel, str, 'gpt-image-1') })] : []
    },
    async embeddings() {
      const which = getSetting(h, PROVIDER_SETTINGS.embeddings, z.enum(['clip', 'openai']), 'clip')
      if (which === 'openai') {
        const key = await secrets.get('openai')
        if (key) return openAiEmbeddings({ apiKey: key })
      }
      let clip = clipCache.get(opts.modelsDir)
      if (!clip) {
        clip = clipLocal(opts.modelsDir)
        clipCache.set(opts.modelsDir, clip)
      }
      return clip
    },
    async llm() {
      const order = getSetting(h, PROVIDER_SETTINGS.llmOrder, z.array(z.enum(LLM_PROVIDER_IDS)), [...LLM_PROVIDER_IDS])
      const out: LlmProvider[] = []
      for (const id of order) {
        if (id === 'anthropic') {
          const key = await secrets.get('anthropic')
          if (key)
            out.push(
              anthropicLlm({
                apiKey: key,
                model: getSetting(h, PROVIDER_SETTINGS.anthropicModel, str, 'claude-opus-5-5'),
                effort: getSetting(h, PROVIDER_SETTINGS.anthropicEffort, z.enum(['low', 'medium', 'high', 'xhigh', 'max']), 'medium'),
              }),
            )
        } else if (id === 'openai') {
          const key = await secrets.get('openai')
          if (key) out.push(openAiLlm({ apiKey: key, model: getSetting(h, PROVIDER_SETTINGS.openaiLlmModel, str, 'gpt-5') }))
        } else {
          const key = await secrets.get('gemini')
          if (key) out.push(geminiLlm({ apiKey: key, model: getSetting(h, PROVIDER_SETTINGS.geminiModel, str, 'gemini-2.5-pro') }))
        }
      }
      return out
    },
    async tts() {
      const order = getSetting(h, PROVIDER_SETTINGS.ttsOrder, z.array(z.enum(TTS_PROVIDER_IDS)), [...TTS_PROVIDER_IDS])
      const out: TtsProvider[] = []
      for (const id of order) {
        if (id === 'elevenlabs') {
          const key = await secrets.get('elevenlabs')
          if (key) out.push(elevenLabsTts({ apiKey: key, model: getSetting(h, PROVIDER_SETTINGS.elevenlabsModel, str, 'eleven_multilingual_v2') }))
        } else if (id === 'openai') {
          const key = await secrets.get('openai')
          if (key) out.push(openAiTts({ apiKey: key, model: getSetting(h, PROVIDER_SETTINGS.openaiTtsModel, str, 'gpt-4o-mini-tts') }))
        } else {
          const key = await secrets.get('azure_speech')
          const region = getSetting(h, PROVIDER_SETTINGS.azureRegion, z.string().regex(/^[a-z0-9]+$/), '')
          if (key && region) out.push(azureTts({ apiKey: key, region }))
        }
      }
      return out
    },
  }
}
