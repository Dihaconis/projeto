import type { WordTime } from './align'

export const SUB_MAX_LINE_CHARS = 32
export const SUB_MAX_LINES = 2

export interface SubtitleStyle {
  /** Família da fonte embarcada (OFL). */
  font: string
  fontSize: number
  /** Cor do texto, hex #RRGGBB. */
  color: string
  /** Cor da palavra atual, hex #RRGGBB. */
  highlight: string
  outline: number
  /** Margem inferior (área segura), px em 1080p. */
  marginV: number
}

export const DEFAULT_SUB_STYLE: SubtitleStyle = {
  font: 'Archivo Black',
  fontSize: 62,
  color: '#FFFFFF',
  highlight: '#FFD400',
  outline: 6,
  marginV: 96,
}

/** #RRGGBB → &H00BBGGRR (ASS usa BGR). */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return '&H00FFFFFF'
  return `&H00${m[3]}${m[2]}${m[1]}`.toUpperCase()
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** Escapa o que o libass interpretaria (chaves e barra invertida). */
function assText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')')
}

export interface Card {
  /** Linhas, cada uma com índices das palavras. */
  lines: number[][]
  first: number
  last: number
  startMs: number
  endMs: number
}

/**
 * Agrupa palavras em "cartões" de no máximo 2 linhas × ~32 caracteres.
 * Fim de frase sempre fecha o cartão; vírgula é ponto preferido de quebra.
 */
export function buildCards(words: WordTime[], holdMs = 300, maxLineChars = SUB_MAX_LINE_CHARS): Card[] {
  const cards: Card[] = []
  let lines: number[][] = [[]]
  const lineLen = (l: number[]) => l.reduce((s, i, k) => s + words[i]!.word.length + (k > 0 ? 1 : 0), 0)
  const close = () => {
    const flat = lines.flat()
    if (flat.length > 0) {
      cards.push({ lines: lines.filter((l) => l.length > 0), first: flat[0]!, last: flat.at(-1)!, startMs: 0, endMs: 0 })
    }
    lines = [[]]
  }
  words.forEach((w, i) => {
    let line = lines.at(-1)!
    const add = w.word.length + (line.length > 0 ? 1 : 0)
    if (line.length > 0 && lineLen(line) + add > maxLineChars) {
      if (lines.length >= SUB_MAX_LINES) close()
      else lines.push([])
      line = lines.at(-1)!
    }
    line.push(i)
    if (/[.!?…]["”»)]?$/u.test(w.word)) close()
    else if (/[,;:—–]$/u.test(w.word) && lines.length === SUB_MAX_LINES && lineLen(line) > maxLineChars * 0.6) close()
  })
  close()
  cards.forEach((c, k) => {
    c.startMs = words[c.first]!.startMs
    const next = cards[k + 1]
    const natural = words[c.last]!.endMs + holdMs
    c.endMs = next ? Math.min(natural, words[next.first]!.startMs) : natural
    if (c.endMs <= c.startMs) c.endMs = c.startMs + 100
  })
  return cards
}

/**
 * Gera o .ASS de um trecho [fromMs, toMs): um evento por palavra, com o cartão
 * inteiro na tela e a palavra atual destacada. Tempos relativos a `fromMs`.
 */
export function buildAss(
  words: WordTime[],
  fromMs: number,
  toMs: number,
  style: SubtitleStyle = DEFAULT_SUB_STYLE,
  canvas: { width: number; height: number; maxLineChars: number } = { width: 1920, height: 1080, maxLineChars: SUB_MAX_LINE_CHARS },
): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.font},${style.fontSize},${assColor(style.color)},${assColor(style.highlight)},&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${style.outline},2,2,${Math.round(canvas.width / 12)},${Math.round(canvas.width / 12)},${style.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const hl = assColor(style.highlight)
  const base = assColor(style.color)
  const events: string[] = []
  for (const card of buildCards(words, 300, canvas.maxLineChars)) {
    for (let k = card.first; k <= card.last; k++) {
      const start = k === card.first ? card.startMs : words[k]!.startMs
      const end = k === card.last ? card.endMs : words[k + 1]!.startMs
      const s = Math.max(start, fromMs)
      const e = Math.min(end, toMs)
      if (e - s < 20) continue
      const text = card.lines
        .map((line) => line.map((i) => (i === k ? `{\\1c${hl}&}${assText(words[i]!.word)}{\\1c${base}&}` : assText(words[i]!.word))).join(' '))
        .join('\\N')
      events.push(`Dialogue: 0,${assTime(s - fromMs)},${assTime(e - fromMs)},Default,,0,0,0,,${text}`)
    }
  }
  return `${[...header, ...events].join('\n')}\n`
}
