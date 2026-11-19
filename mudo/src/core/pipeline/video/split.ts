import { countWords, splitSentences } from '../../prompts/script'

export const SCENE_MIN_S = 5
export const SCENE_MAX_S = 10

export interface SplitScene {
  text: string
  estS: number
}

const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim()

/** Quebra uma frase longa em orações (vírgula, ponto e vírgula, dois-pontos, travessão). */
function splitClauses(sentence: string): string[] {
  return sentence
    .split(/(?<=[,;:—–])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Último recurso: divide por palavras em partes iguais. */
function splitByWords(text: string, parts: number): string[] {
  const words = text.split(/\s+/u).filter(Boolean)
  const size = Math.ceil(words.length / parts)
  const out: string[] = []
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '))
  return out
}

/**
 * Divide o texto de um ato em cenas de 5–10 s (seção 8.3), por frase e, se
 * preciso, por oração. Determinístico e sem perda: juntar as cenas com espaço
 * devolve o texto original normalizado.
 */
export function splitActIntoScenes(actText: string, wpm: number): SplitScene[] {
  const wps = wpm / 60
  const dur = (t: string) => countWords(t) / wps

  // 1) peças de no máximo ~10 s
  const pieces: string[] = []
  for (const sentence of splitSentences(normalize(actText))) {
    if (dur(sentence) <= SCENE_MAX_S) {
      pieces.push(sentence)
      continue
    }
    let cur = ''
    for (const clause of splitClauses(sentence)) {
      if (dur(clause) > SCENE_MAX_S) {
        if (cur) pieces.push(cur)
        cur = ''
        pieces.push(...splitByWords(clause, Math.ceil(dur(clause) / (SCENE_MAX_S * 0.8))))
        continue
      }
      const joined = cur ? `${cur} ${clause}` : clause
      if (dur(joined) <= SCENE_MAX_S) cur = joined
      else {
        pieces.push(cur)
        cur = clause
      }
    }
    if (cur) pieces.push(cur)
  }

  // 2) junta peças curtas até atingir 5 s sem passar de 10 s
  const scenes: string[] = []
  let cur = ''
  for (const p of pieces) {
    if (!cur) {
      cur = p
    } else if (dur(cur) < SCENE_MIN_S && dur(`${cur} ${p}`) <= SCENE_MAX_S) {
      cur = `${cur} ${p}`
    } else {
      scenes.push(cur)
      cur = p
    }
  }
  if (cur) {
    // sobra curta no fim do ato: cola na cena anterior se couber
    const prev = scenes[scenes.length - 1]
    if (prev !== undefined && dur(cur) < SCENE_MIN_S && dur(`${prev} ${cur}`) <= SCENE_MAX_S) {
      scenes[scenes.length - 1] = `${prev} ${cur}`
    } else scenes.push(cur)
  }
  return scenes.map((text) => ({ text, estS: dur(text) }))
}
