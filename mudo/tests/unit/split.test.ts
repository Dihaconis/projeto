import { describe, expect, it } from 'vitest'
import { SCENE_MAX_S, SCENE_MIN_S, splitActIntoScenes } from '../../src/core'
import { countWords } from '../../src/core/prompts/script'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('divisão em cenas (8.3)', () => {
  it('não perde nem altera texto', () => {
    const text = 'Primeira frase curta. Segunda frase, um pouco maior, com vírgulas e tudo! Terceira? Quarta frase termina aqui.'
    const scenes = splitActIntoScenes(text, 150)
    expect(norm(scenes.map((s) => s.text).join(' '))).toBe(norm(text))
  })

  it('cenas entre 5 e 10 s quando o texto permite', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i + 1} do ato com algumas palavras a mais.`).join(' ')
    const scenes = splitActIntoScenes(text, 150)
    for (const s of scenes) {
      expect(s.estS).toBeLessThanOrEqual(SCENE_MAX_S + 1e-9)
      expect(s.estS).toBeGreaterThanOrEqual(SCENE_MIN_S - 1e-9)
    }
  })

  it('frase longa demais é quebrada por oração e, em último caso, por palavras', () => {
    const longClause = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(' ')
    const text = `Começo curto, depois uma oração bem comprida que segue, e mais uma oração; e por fim ${longClause}.`
    const scenes = splitActIntoScenes(text, 150)
    expect(scenes.length).toBeGreaterThan(2)
    for (const s of scenes) expect(s.estS).toBeLessThanOrEqual(SCENE_MAX_S + 1e-9)
    expect(norm(scenes.map((s) => s.text).join(' '))).toBe(norm(text))
    expect(scenes.reduce((n, s) => n + countWords(s.text), 0)).toBe(countWords(text))
  })

  it('sobra curta no fim do ato vai para a cena anterior se couber', () => {
    const text = 'Uma frase com exatamente doze palavras para dar quase cinco segundos de fala. Fim.'
    const scenes = splitActIntoScenes(text, 150)
    expect(scenes).toHaveLength(1)
  })
})
