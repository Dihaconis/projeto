import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMediaBinaries, runProcess } from '../../src/core'
import { alignToKnown, displayWords, whisperAlign, wordsFromCharAlignment } from '../../src/core/media/align'
import { MOTIONS, pickMotions, zoompanFilter } from '../../src/core/media/motion'
import { mixAndNormalize, musicExpression } from '../../src/core/media/music'
import { SUB_MAX_LINE_CHARS, assColor, buildAss, buildCards } from '../../src/core/media/subtitles'
import { parseSilences } from '../../src/core/pipeline/video/tts-stage'
import { tempRoot, slow } from '../helpers/env'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })))
const bins = resolveMediaBinaries()
const spawn = (c: string, a: readonly string[], o?: object) => runProcess(c, a, { ...(o ?? {}), signal: new AbortController().signal })

describe('movimento (8.6)', () => {
  it('alterna os 4 movimentos, nunca dois iguais seguidos, determinístico por vídeo', () => {
    const a = pickMotions(80, 'video-1')
    expect(a).toEqual(pickMotions(80, 'video-1'))
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1])
    expect(new Set(a)).toEqual(new Set(MOTIONS))
    expect(pickMotions(1, 'x', 'zoom_in')[0]).not.toBe('zoom_in')
  })
  it('zoompan sutil sobre 4K saindo em 1080p', () => {
    const f = zoompanFilter('zoom_in', 150, 0.06, 30)
    expect(f).toContain('s=1920x1080')
    expect(f).toContain('d=150')
    expect(f).toContain('1+0.0600*')
  })
})

describe('legenda .ASS (8.6)', () => {
  const words = 'Você olha para cima todo dia e vê azul. Mas a luz do Sol é branca, e isso confunde muita gente que olha o céu.'
    .split(' ')
    .map((w, i) => ({ word: w, startMs: i * 300, endMs: i * 300 + 250 }))

  it('cartões de até 2 linhas × ~32 caracteres; frase termina o cartão', () => {
    const cards = buildCards(words)
    for (const c of cards) {
      expect(c.lines.length).toBeLessThanOrEqual(2)
      for (const l of c.lines) expect(l.map((i) => words[i]!.word).join(' ').length).toBeLessThanOrEqual(SUB_MAX_LINE_CHARS)
    }
    expect(words[cards[0]!.last]!.word).toBe('azul.')
    // cartão não invade o próximo
    for (let k = 1; k < cards.length; k++) expect(cards[k - 1]!.endMs).toBeLessThanOrEqual(cards[k]!.startMs)
  })

  it('um evento por palavra com a palavra atual destacada, tempos relativos ao trecho', () => {
    const ass = buildAss(words, 1000, 5000)
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(events.length).toBeGreaterThan(5)
    expect(events[0]).toMatch(/^Dialogue: 0,0:00:00\.00,/)
    expect(ass).toContain(`{\\1c${assColor('#FFD400')}&}`)
    expect(ass).toContain('Alignment')
    expect(assColor('#112233')).toBe('&H00332211')
  })
})

describe('alinhamento de palavras (8.5)', () => {
  it('timestamps por caractere do provedor, descontando o silêncio cortado', () => {
    const text = 'Olá mundo bonito'
    const chars = [...text]
    const al = { chars, startS: chars.map((_, i) => 0.25 + i * 0.05), endS: chars.map((_, i) => 0.3 + i * 0.05) }
    const w = wordsFromCharAlignment(text, al, 250)
    expect(w.map((x) => x.word)).toEqual(['Olá', 'mundo', 'bonito'])
    expect(w[0]!.startMs).toBe(0)
    expect(w[1]!.startMs).toBe(200)
  })

  it('DP: palavras reconhecidas erradas/faltando recebem tempo interpolado; texto exibido é o do roteiro', () => {
    const known = displayWords('E então, meus caros, perguntem não o que o país pode fazer.')
    const rec = [
      { text: 'e', from: 0, to: 100 },
      { text: 'entao', from: 100, to: 400 },
      { text: 'meus', from: 500, to: 700 },
      { text: 'caras', from: 700, to: 1000 }, // erro de reconhecimento
      { text: 'perguntem', from: 1100, to: 1600 },
      { text: 'pais', from: 2200, to: 2500 },
      { text: 'fazer', from: 2800, to: 3200 },
    ]
    const out = alignToKnown(known, rec, 3300)
    expect(out.map((w) => w.word)).toEqual(known)
    expect(out[1]).toMatchObject({ startMs: 100 })
    expect(out[4]).toMatchObject({ startMs: 1100 })
    for (let i = 1; i < out.length; i++) expect(out[i]!.startMs).toBeGreaterThanOrEqual(out[i - 1]!.startMs)
    expect(out.at(-1)!.endMs).toBe(3200)
  })

  it('whisper.cpp em fala real (domínio público) alinha ao texto conhecido', async () => {
    const tmp = tempRoot()
    roots.push(tmp)
    const text = 'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.'
    const words = await whisperAlign(spawn, bins, path.resolve(__dirname, '../fixtures/audio/jfk.wav'), text, 'en', tmp, 11_000)
    expect(words.map((w) => w.word)).toEqual(displayWords(text))
    const americans = words.find((w) => w.word.startsWith('Americans'))!
    expect(Math.abs(americans.startMs - 1750)).toBeLessThan(300)
    const last = words.at(-1)!
    expect(last.endMs).toBeGreaterThan(9500)
  }, slow(120_000))

  it('silêncio nas pontas lido do silencedetect', () => {
    const lines = ['[silencedetect] silence_start: 0', '[silencedetect] silence_end: 0.25 | silence_duration: 0.25', '[silencedetect] silence_start: 3.85']
    expect(parseSilences(lines, 4)).toEqual({ leadS: 0.25, tailS: 4 - 3.85 })
    expect(parseSilences([], 4)).toEqual({ leadS: 0, tailS: 0 })
  })
})

describe('trilha (8.6)', () => {
  it('música abaixa sob a voz (sidechain) e o resultado fica em −14 LUFS', async () => {
    const d = tempRoot()
    roots.push(d)
    const run = (args: string[]) => spawnSync(bins.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args])
    // "voz" aguda nos primeiros 4 s, depois silêncio; "música" grave contínua
    run(['-f', 'lavfi', '-i', 'sine=f=3000:d=4', '-af', 'volume=0.5,apad=whole_dur=8', '-ac', '1', '-ar', '48000', `${d}/voz.wav`])
    run(['-f', 'lavfi', '-i', 'sine=f=200:d=8', '-ac', '2', '-ar', '48000', `${d}/musica.wav`])
    await mixAndNormalize(spawn, bins, { narration: `${d}/voz.wav`, music: `${d}/musica.wav`, totalS: 8, out: `${d}/final.wav`, tmpDir: d })
    const rms = (from: number, to: number) => {
      const r = spawnSync(bins.ffmpeg, ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', `${d}/final.wav`, '-af', 'lowpass=f=400,astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' })
      return Number(/RMS level dB:\s*(-?[\d.]+)/.exec(r.stderr)?.[1])
    }
    const underVoice = rms(1.5, 3.5)
    const alone = rms(5.5, 6.5) // antes do fade final
    expect(alone - underVoice).toBeGreaterThan(6)
    expect(musicExpression('calm')).toContain('sin(2*PI*')
  }, slow(60_000))
})
