import { z } from 'zod'
import { LANGUAGE_NAMES, type Language } from '../../shared/enums'
import { actSchema, type Act } from './script'

export const REVIEW_PROMPT_VERSION = 'review@1'

export const ISSUE_KINDS = ['coherence', 'hook', 'pacing', 'act_length', 'repetition', 'factual'] as const

export const reviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(
    z.object({
      kind: z.enum(ISSUE_KINDS),
      act: z.number().int().min(1).nullable(),
      note: z.string().trim().min(1),
    }),
  ),
  revisedActs: z.array(actSchema).min(5).max(7).nullable(),
})
export type Review = z.infer<typeof reviewSchema>
export type ReviewIssue = Review['issues'][number]

export const reviewJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'issues', 'revisedActs'],
  properties: {
    approved: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'act', 'note'],
        properties: {
          kind: { type: 'string', enum: [...ISSUE_KINDS] },
          act: { type: ['integer', 'null'] },
          note: { type: 'string' },
        },
      },
    },
    revisedActs: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'heading', 'text'],
        properties: { n: { type: 'integer' }, heading: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
} as const

export interface ReviewPromptInput {
  language: Language
  theme: string
  hook: string
  acts: Act[]
  targetWords: number
}

/** Rubrica explícita (seção 8.2). Dúvidas factuais são listadas, nunca removidas em silêncio. */
export function buildReviewPrompt(i: ReviewPromptInput): { system: string; prompt: string } {
  const lang = LANGUAGE_NAMES[i.language]
  const system = [
    'You are a strict script editor for narrated YouTube videos. You review a script against a rubric and either approve it or return a revised version.',
    `Write issue notes in ${lang}. Any revised narration must also be in ${lang}.`,
    'Reply with JSON only, matching the requested schema.',
  ].join('\n')
  const perAct = Math.round(i.targetWords / i.acts.length)
  const prompt = [
    `Theme: ${i.theme}`,
    `Target total words: ${i.targetWords} (±10%); balanced acts of roughly ${perAct} words each.`,
    '',
    'Rubric — check every item:',
    '1. coherence: the acts follow a logical line, no contradictions, no gaps.',
    '2. hook: act 1 opens with at most 2 hook sentences and a clear promise; the remaining acts actually deliver that promise.',
    '3. pacing: no dragging passages, no rushed ending.',
    '4. act_length: no act much longer or shorter than the others without reason.',
    '5. repetition: no repeated ideas, phrases or sentence openings.',
    '6. factual: list every claim that is dubious, unverifiable or likely wrong. Do NOT delete them silently — list each one as an issue so the user can decide.',
    '',
    'Set approved=true when the script is publishable as is (factual notes alone do not block approval if they are framed with appropriate uncertainty). Then revisedActs must be null.',
    'Set approved=false when coherence, hook, pacing, act_length or repetition problems need fixing. Then return revisedActs: the full corrected list of acts (same count, numbered from 1), keeping the total within the word target. Keep doubtful facts out of the revision or reframe them with uncertainty, and still list them in issues.',
    '',
    `Hook: ${i.hook}`,
    '',
    ...i.acts.map((a) => `### Act ${a.n} — ${a.heading}\n${a.text}`),
  ].join('\n')
  return { system, prompt }
}
