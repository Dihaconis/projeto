import { z } from 'zod'
import { LANGUAGE_NAMES, type Language } from '../../shared/enums'

export const SCRIPT_PROMPT_VERSION = 'script@1'

export const actSchema = z.object({
  n: z.number().int().min(1),
  heading: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1),
})
export type Act = z.infer<typeof actSchema>

/** Saída do roteiro (seção 8.1). `thumbnail_title` alimenta a thumbnail (máx. 5 palavras). */
export const scriptSchema = z.object({
  title: z.string().trim().min(3).max(100),
  hook: z.string().trim().min(1),
  acts: z.array(actSchema).min(5).max(7),
  description: z.string().trim().min(1).max(5000),
  tags: z.array(z.string().trim().min(1)).min(1).max(30),
  thumbnail_title: z.string().trim().min(1).max(60),
})
export type Script = z.infer<typeof scriptSchema>

export const scriptJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'hook', 'acts', 'description', 'tags', 'thumbnail_title'],
  properties: {
    title: { type: 'string' },
    hook: { type: 'string' },
    acts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'heading', 'text'],
        properties: { n: { type: 'integer' }, heading: { type: 'string' }, text: { type: 'string' } },
      },
    },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    thumbnail_title: { type: 'string' },
  },
} as const

export interface ScriptPromptInput {
  theme: string
  language: Language
  targetS: number
  targetWords: number
  channel: { name: string; niche: string; scriptStyle?: string | undefined }
  /** Títulos recentes do canal, para não repetir estrutura. */
  recentTitles: string[]
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

export function scriptWordCount(acts: ReadonlyArray<Pick<Act, 'text'>>): number {
  return acts.reduce((n, a) => n + countWords(a.text), 0)
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"“¿¡«(])/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Regras do roteiro além do schema. Devolve a lista de problemas (vazia = ok). */
export function scriptProblems(s: Script, targetWords: number): string[] {
  const problems: string[] = []
  s.acts.forEach((a, i) => {
    if (a.n !== i + 1) problems.push(`acts[${i}].n deve ser ${i + 1}, veio ${a.n}`)
  })
  const words = scriptWordCount(s.acts)
  const min = Math.floor(targetWords * 0.9)
  const max = Math.ceil(targetWords * 1.1)
  if (words < min || words > max) {
    problems.push(`o texto narrado (soma de acts[].text) tem ${words} palavras; precisa ter entre ${min} e ${max} (alvo ${targetWords})`)
  }
  const hookSentences = splitSentences(s.hook).length
  if (hookSentences > 2) problems.push(`hook tem ${hookSentences} frases; máximo 2`)
  const thumbWords = countWords(s.thumbnail_title)
  if (thumbWords > 5) problems.push(`thumbnail_title tem ${thumbWords} palavras; máximo 5`)
  return problems
}

export function buildScriptPrompt(i: ScriptPromptInput): { system: string; prompt: string } {
  const lang = LANGUAGE_NAMES[i.language]
  const minutes = (i.targetS / 60).toFixed(1).replace(/\.0$/, '')
  const system = [
    `You write narration scripts for a faceless YouTube channel. Everything you write — title, hook, headings, narration, description, tags, thumbnail title — must be in ${lang}.`,
    'Write for the ear: short sentences, concrete images, no stage directions, no markdown, no emojis, no bracketed notes. The narration text is read aloud by a text-to-speech voice exactly as written.',
    'Do not invent statistics, quotes or dates. When a fact is uncertain, say so plainly in the narration instead of stating it as certain.',
    'Vary sentence structure and openings; never reuse a fixed template between videos.',
    'Reply with JSON only, matching the requested schema.',
  ].join('\n')
  const prompt = [
    `Channel: "${i.channel.name}" — niche: ${i.channel.niche}.`,
    i.channel.scriptStyle ? `Channel tone and style: ${i.channel.scriptStyle}` : '',
    `Video theme: ${i.theme}`,
    `Target length: about ${minutes} minutes of narration, which is ${i.targetWords} words in total across all acts (acceptable: ${Math.floor(i.targetWords * 0.9)}–${Math.ceil(i.targetWords * 1.1)}). Count carefully.`,
    '',
    'Structure:',
    '- 5 to 7 acts, numbered n = 1, 2, 3…',
    '- Act 1 is the hook: at most 2 sentences of hook, followed by a clear promise of what the viewer will get from the video. Put those same hook sentences in the "hook" field too.',
    '- The other acts deliver on that promise in a logical progression and end with a satisfying conclusion. Balance the length of the acts.',
    '- "heading": a short internal label for each act (not read aloud).',
    '- "text": the exact narration for that act.',
    '- "title": a compelling video title (max 100 characters), no clickbait lies.',
    '- "description": 2–4 short paragraphs for the video description.',
    '- "tags": 8–15 search tags.',
    '- "thumbnail_title": at most 5 words, punchy, for the thumbnail.',
    i.recentTitles.length > 0
      ? `Recent videos on this channel (do not reuse their structure or opening lines): ${i.recentTitles.map((t) => `"${t}"`).join('; ')}`
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n')
  return { system, prompt }
}

export function scriptRetryPrompt(base: string, previous: string, problems: string[]): string {
  return [
    base,
    '',
    'Your previous answer was rejected for these reasons:',
    ...problems.map((p) => `- ${p}`),
    '',
    'Previous answer:',
    previous.slice(0, 20_000),
    '',
    'Return a corrected, complete JSON answer.',
  ].join('\n')
}
