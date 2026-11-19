import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Language } from '../../shared/enums'
import type { CharAlignment } from '../providers/types'
import { JobError } from '../queue/errors'
import { runFfmpeg, type MediaBinaries, type Spawner } from './ffmpeg'

/** Palavra com tempo em ms, relativo ao início do trecho de áudio. */
export interface WordTime {
  word: string
  startMs: number
  endMs: number
}

/** Palavras como serão exibidas (pontuação colada à palavra). */
export function displayWords(text: string): string[] {
  return text.trim().split(/\s+/u).filter(Boolean)
}

/** Forma comparável: minúsculas, sem acento e sem pontuação. */
export function normWord(w: string): string {
  return w
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Timestamps por caractere do provedor (ElevenLabs) → palavras. `shiftMs` é
 * subtraído (silêncio cortado no início do trecho).
 */
export function wordsFromCharAlignment(text: string, al: CharAlignment, shiftMs = 0): WordTime[] {
  const words: WordTime[] = []
  let cur = ''
  let start = -1
  let end = 0
  const flush = () => {
    if (cur.trim()) words.push({ word: cur.trim(), startMs: Math.max(0, start * 1000 - shiftMs), endMs: Math.max(0, end * 1000 - shiftMs) })
    cur = ''
    start = -1
  }
  al.chars.forEach((ch, i) => {
    if (/\s/u.test(ch)) return flush()
    if (start < 0) start = al.startS[i] ?? 0
    end = al.endS[i] ?? end
    cur += ch
  })
  flush()
  // o provedor normaliza o texto às vezes (números, aspas): alinha às palavras exibidas
  return alignToKnown(displayWords(text), words.map((w) => ({ text: w.word, from: w.startMs, to: w.endMs })), words.at(-1)?.endMs ?? 0)
}

const whisperJsonSchema = z.object({
  transcription: z.array(z.object({ offsets: z.object({ from: z.number(), to: z.number() }), text: z.string() })),
})

export interface Recognized {
  text: string
  from: number
  to: number
}

export function parseWhisperJson(raw: string): Recognized[] {
  const j = whisperJsonSchema.parse(JSON.parse(raw))
  return j.transcription.map((t) => ({ text: t.text.trim(), from: t.offsets.from, to: t.offsets.to })).filter((t) => normWord(t.text) !== '')
}

/**
 * Alinha as palavras conhecidas (roteiro) às reconhecidas (com tempo) por
 * programação dinâmica (Needleman–Wunsch). Palavras sem par recebem tempo
 * interpolado entre os vizinhos, proporcional ao tamanho. O texto exibido é
 * sempre o do roteiro — o reconhecimento só fornece o relógio.
 */
export function alignToKnown(known: string[], rec: Recognized[], totalMs: number): WordTime[] {
  const n = known.length
  const m = rec.length
  const a = known.map(normWord)
  const b = rec.map((r) => normWord(r.text))
  const GAP = -1
  const score = (x: string, y: string) => (x === y ? 2 : x && y && (x.startsWith(y) || y.startsWith(x)) ? 1 : -1)
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i + j) * GAP))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = Math.max(dp[i - 1]![j - 1]! + score(a[i - 1]!, b[j - 1]!), dp[i - 1]![j]! + GAP, dp[i]![j - 1]! + GAP)
    }
  }
  const match: Array<Recognized | null> = Array(n).fill(null)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (dp[i]![j] === dp[i - 1]![j - 1]! + score(a[i - 1]!, b[j - 1]!)) {
      if (score(a[i - 1]!, b[j - 1]!) > 0) match[i - 1] = rec[j - 1]!
      i--
      j--
    } else if (dp[i]![j] === dp[i - 1]![j]! + GAP) i--
    else j--
  }

  const out: WordTime[] = known.map((w, k) => ({ word: w, startMs: match[k]?.from ?? NaN, endMs: match[k]?.to ?? NaN }))
  // interpola os buracos entre âncoras
  let k = 0
  while (k < n) {
    if (!Number.isNaN(out[k]!.startMs)) {
      k++
      continue
    }
    let e = k
    while (e < n && Number.isNaN(out[e]!.startMs)) e++
    const from = k > 0 ? out[k - 1]!.endMs : 0
    const to = e < n ? out[e]!.startMs : Math.max(from, totalMs)
    const lens = out.slice(k, e).map((w) => Math.max(1, w.word.length))
    const total = lens.reduce((s, x) => s + x, 0)
    let t = from
    for (let x = k; x < e; x++) {
      const d = ((to - from) * lens[x - k]!) / total
      out[x]!.startMs = t
      out[x]!.endMs = t + d
      t += d
    }
    k = e
  }
  // garante ordem monotônica
  for (let x = 1; x < n; x++) {
    if (out[x]!.startMs < out[x - 1]!.startMs) out[x]!.startMs = out[x - 1]!.startMs
    if (out[x]!.endMs < out[x]!.startMs) out[x]!.endMs = out[x]!.startMs
  }
  return out.map((w) => ({ word: w.word, startMs: Math.round(w.startMs), endMs: Math.round(w.endMs) }))
}

const WHISPER_LANG: Record<Language, string> = { 'pt-BR': 'pt', es: 'es', en: 'en' }

/**
 * Sem timestamps do provedor: roda o whisper.cpp (modelo base) sobre o trecho
 * e alinha ao texto conhecido (seção 8.5).
 */
export async function whisperAlign(
  spawn: Spawner,
  bins: MediaBinaries,
  wav: string,
  text: string,
  language: Language,
  tmpDir: string,
  durationMs: number,
): Promise<WordTime[]> {
  if (!bins.whisper || !bins.whisperModel) throw new JobError('INTERNAL', 'whisper.cpp não encontrado (resources/bin e resources/models)')
  fs.mkdirSync(tmpDir, { recursive: true })
  const base = path.join(tmpDir, `${path.parse(wav).name}.w`)
  const wav16 = `${base}.16k.wav`
  await runFfmpeg(spawn, bins, ['-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav16], { what: 'preparar o áudio para alinhamento' })
  const r = await spawn(bins.whisper, ['-m', bins.whisperModel, '-f', wav16, '-l', WHISPER_LANG[language], '-ml', '1', '-sow', '-oj', '-of', base, '-np', '-t', '4'])
  if (r.code !== 0 || !fs.existsSync(`${base}.json`)) {
    throw new JobError('INTERNAL', `whisper.cpp falhou ao alinhar a narração (código ${r.code})`, true, { stderr: r.stderrTail.slice(-800) })
  }
  const rec = parseWhisperJson(fs.readFileSync(`${base}.json`, 'utf8'))
  fs.rmSync(wav16, { force: true })
  fs.rmSync(`${base}.json`, { force: true })
  return alignToKnown(displayWords(text), rec, durationMs)
}
