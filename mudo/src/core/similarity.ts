import { normWord } from './media/align'
import { splitSentences } from './prompts/script'

/**
 * Similaridade entre roteiros do mesmo canal (seção 10). Mede reaproveitamento
 * de estrutura: sequências de 3 palavras em comum e aberturas de frase
 * repetidas. Local e determinístico — o CLIP só lê 77 tokens, curto demais
 * para um roteiro inteiro.
 */
function words(text: string): string[] {
  return text.split(/\s+/u).map(normWord).filter(Boolean)
}

export function shingles(text: string, n = 3): Set<string> {
  const w = words(text)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Aberturas de frase (3 primeiras palavras) — o "molde" que deixa vídeos repetitivos. */
export function openings(text: string): Set<string> {
  return new Set(splitSentences(text).map((s) => words(s).slice(0, 3).join(' ')).filter((s) => s.split(' ').length === 3))
}

export function scriptSimilarity(a: string, b: string): number {
  const shingle = jaccard(shingles(a), shingles(b))
  const oa = openings(a)
  const ob = openings(b)
  let shared = 0
  for (const x of oa) if (ob.has(x)) shared++
  const opening = oa.size ? shared / oa.size : 0
  return Math.max(shingle, opening * 0.8)
}

export const DEFAULT_MAX_SIMILARITY = 0.3
