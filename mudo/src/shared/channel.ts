import { z } from 'zod'
import { DURATION, LANGUAGES } from './enums'

/** Preset do canal (seção 10). Campos de legenda/movimento/música entram na Fase 4/6. */
export const stylePresetSchema = z.object({
  /** "Revisar manualmente sempre" (seção 8.2): para em needs_input mesmo aprovado. */
  manualReview: z.boolean().default(false),
  /** Tom/estilo de roteiro do canal, passado ao LLM. */
  scriptStyle: z.string().trim().max(500).optional(),
})
export type StylePreset = z.infer<typeof stylePresetSchema>

export const channelInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  niche: z.string().trim().min(1).max(200),
  language: z.enum(LANGUAGES),
  ttsProvider: z.enum(['elevenlabs', 'openai', 'azure']).optional(),
  voiceId: z.string().trim().min(1).max(120).optional(),
  musicMood: z.string().trim().min(1).max(40).optional(),
  stylePreset: stylePresetSchema.optional(),
})
export type ChannelInput = z.input<typeof channelInputSchema>

export const videoRequestSchema = z.object({
  channelId: z.string().min(1),
  theme: z.string().trim().min(3, 'o tema precisa ter pelo menos 3 caracteres').max(500),
  language: z.enum(LANGUAGES).optional(),
  durationS: z.number().int().min(DURATION.shortTestMinS).max(DURATION.maxS).default(DURATION.defaultS),
})
export type VideoRequest = z.input<typeof videoRequestSchema>
