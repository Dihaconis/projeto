import { z } from 'zod'

export const CUTS_PROMPT_VERSION = 'cuts@1'

export const CUT_MIN_S = 15
export const CUT_MAX_S = 90

export const highlightsSchema = z.object({
  highlights: z
    .array(
      z.object({
        start_s: z.number().min(0),
        end_s: z.number().min(0),
        score: z.number().int().min(0).max(100),
        title: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(1).max(400),
      }),
    )
    .min(1)
    .max(10),
})
export type Highlights = z.infer<typeof highlightsSchema>

export const highlightsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['highlights'],
  properties: {
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start_s', 'end_s', 'score', 'title', 'reason'],
        properties: {
          start_s: { type: 'number' },
          end_s: { type: 'number' },
          score: { type: 'integer' },
          title: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const

export interface TranscriptSentence {
  startMs: number
  endMs: number
  text: string
}

/**
 * Escolhe trechos com potencial de corte vertical (seção 11.3): nota 0–100
 * com justificativa. Só trechos que se sustentam sozinhos.
 */
export function buildCutsPrompt(sentences: TranscriptSentence[], durationS: number): { system: string; prompt: string } {
  const system = [
    'You are an editor who picks short-form clips (vertical, 15–90 s) from a longer video the creator owns.',
    'A good clip stands on its own: it opens with a hook, makes one clear point or tells one complete moment, and ends cleanly.',
    'Score each clip 0–100 for how likely it is to hold attention on its own, and justify the score in one or two sentences.',
    'Be honest: an ordinary passage should get a low score. Never invent content that is not in the transcript.',
    'Write titles and reasons in the same language as the transcript. Reply with JSON only, matching the requested schema.',
  ].join('\n')
  const prompt = [
    `Video length: ${durationS.toFixed(0)} s. Pick 1 to 6 non-overlapping clips, each between ${CUT_MIN_S} and ${CUT_MAX_S} seconds.`,
    'Use start_s and end_s that match sentence boundaries from the transcript below (seconds).',
    '',
    ...sentences.map((s) => `[${(s.startMs / 1000).toFixed(1)}–${(s.endMs / 1000).toFixed(1)}] ${s.text}`),
  ].join('\n')
  return { system, prompt }
}
