import fs from 'node:fs'

/** PCM s16le mono 48 kHz — formato interno de toda a narração. */
export const PCM = { rate: 48_000, channels: 1, bytesPerSample: 2 } as const

export const msToBytes = (ms: number) =>
  Math.round((ms * PCM.rate) / 1000) * PCM.bytesPerSample * PCM.channels

export const bytesToMs = (bytes: number) => (bytes / (PCM.bytesPerSample * PCM.channels) / PCM.rate) * 1000

/** Lê o bloco `data` de um WAV PCM s16le mono 48 kHz. */
export function readWavPcm(file: string): Buffer {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`não é WAV: ${file}`)
  }
  let off = 12
  let fmtOk = false
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const rate = buf.readUInt32LE(body + 4)
      const bits = buf.readUInt16LE(body + 14)
      fmtOk = format === 1 && channels === PCM.channels && rate === PCM.rate && bits === 16
      if (!fmtOk) throw new Error(`WAV fora do formato interno (fmt=${format} ch=${channels} rate=${rate} bits=${bits})`)
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('WAV sem bloco fmt antes de data')
      const end = Math.min(buf.length, body + size)
      return buf.subarray(body, end - ((end - body) % 2))
    }
    off = body + size + (size % 2)
  }
  throw new Error(`WAV sem bloco data: ${file}`)
}

export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(PCM.channels, 22)
  h.writeUInt32LE(PCM.rate, 24)
  h.writeUInt32LE(PCM.rate * PCM.channels * PCM.bytesPerSample, 28)
  h.writeUInt16LE(PCM.channels * PCM.bytesPerSample, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export interface NarrationPart {
  wavPath: string
  /** Silêncio depois desta parte (250 ms entre cenas, 600 ms entre atos). */
  pauseAfterMs: number
}

export interface NarrationTimeline {
  /** Início/fim da fala de cada parte, em ms, na narração final. */
  parts: Array<{ startMs: number; endMs: number }>
  totalMs: number
}

/**
 * Junta as partes com silêncios exatos, amostra por amostra, e devolve a linha
 * do tempo de cada cena (base para cortes e legendas).
 */
export function buildNarrationWav(parts: NarrationPart[], outFile: string): NarrationTimeline {
  const chunks: Buffer[] = []
  const timeline: NarrationTimeline['parts'] = []
  let bytes = 0
  for (const p of parts) {
    const pcm = readWavPcm(p.wavPath)
    const startMs = bytesToMs(bytes)
    chunks.push(pcm)
    bytes += pcm.length
    timeline.push({ startMs, endMs: bytesToMs(bytes) })
    if (p.pauseAfterMs > 0) {
      const silence = Buffer.alloc(msToBytes(p.pauseAfterMs))
      chunks.push(silence)
      bytes += silence.length
    }
  }
  const tmp = `${outFile}.part`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, wavHeader(bytes))
    for (const c of chunks) fs.writeSync(fd, c)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, outFile)
  return { parts: timeline, totalMs: bytesToMs(bytes) }
}
