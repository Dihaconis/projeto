import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PCM, buildNarrationWav, readWavPcm, sceneFrames, wavHeader } from '../../src/core'
import { tempRoot } from '../helpers/env'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })))

function wav(dir: string, name: string, ms: number): string {
  const bytes = Math.round((ms * PCM.rate) / 1000) * 2
  const f = path.join(dir, name)
  fs.writeFileSync(f, Buffer.concat([wavHeader(bytes), Buffer.alloc(bytes, 1)]))
  return f
}

describe('narração e linha do tempo (8.5)', () => {
  it('junta com pausas exatas de 250/600 ms e devolve início/fim de cada cena', () => {
    const d = tempRoot()
    roots.push(d)
    const parts = [
      { wavPath: wav(d, 'a.wav', 1000), pauseAfterMs: 250 },
      { wavPath: wav(d, 'b.wav', 2000), pauseAfterMs: 600 },
      { wavPath: wav(d, 'c.wav', 500), pauseAfterMs: 0 },
    ]
    const out = path.join(d, 'n.wav')
    const tl = buildNarrationWav(parts, out)
    expect(tl.parts).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 1250, endMs: 3250 },
      { startMs: 3850, endMs: 4350 },
    ])
    expect(tl.totalMs).toBe(4350)
    expect(readWavPcm(out).length).toBe((4350 * PCM.rate * 2) / 1000)
  })

  it('quadros por cena somam o total e não acumulam deriva', () => {
    const starts = [0, 1250, 3850, 7333.4, 9999.9]
    const total = 12_345.6
    const f = sceneFrames(starts, total, 30)
    expect(f.reduce((a, b) => a + b, 0)).toBe(Math.round((total * 30) / 1000))
    // cada fronteira cai no quadro mais próximo do início da fala
    let acc = 0
    f.forEach((n, i) => {
      if (i > 0) expect(Math.abs(acc - (starts[i]! * 30) / 1000)).toBeLessThanOrEqual(0.5)
      acc += n
    })
  })
})
