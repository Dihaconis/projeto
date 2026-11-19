import { z } from 'zod'
import { LANGUAGE_NAMES, type Language } from '../../shared/enums'

export const SCENES_PROMPT_VERSION = 'scenes@1'

export const sceneQueriesSchema = z.object({
  scenes: z.array(z.object({ n: z.number().int().min(1), image_query: z.string().trim().min(3).max(120) })),
})
export type SceneQueries = z.infer<typeof sceneQueriesSchema>

export const sceneQueriesJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scenes'],
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'image_query'],
        properties: { n: { type: 'integer' }, image_query: { type: 'string' } },
      },
    },
  },
} as const

/**
 * Para cada cena, uma busca visual concreta (seção 8.3): o que aparece na tela,
 * não o conceito abstrato. Em inglês, porque os bancos de imagem indexam assim.
 */
export function buildSceneQueriesPrompt(i: {
  language: Language
  theme: string
  scenes: Array<{ n: number; text: string }>
}): { system: string; prompt: string } {
  const system = [
    'You choose stock photos for narrated videos. For each scene you write one image search query.',
    'The query describes something concrete that can be photographed: subject, setting, action, maybe lighting. Never abstract concepts ("success", "the idea of time"), never text or logos, never real people by name.',
    'Write each query in English, 3 to 8 words. Consecutive scenes should not get the same query.',
    'Reply with JSON only, matching the requested schema.',
  ].join('\n')
  const prompt = [
    `Video theme: ${i.theme}`,
    `The narration is in ${LANGUAGE_NAMES[i.language]}. Return exactly one entry per scene, same n values, same order.`,
    '',
    ...i.scenes.map((s) => `${s.n}. ${s.text}`),
  ].join('\n')
  return { system, prompt }
}
