import { createHash } from 'node:crypto'

export const MOTIONS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right'] as const
export type Motion = (typeof MOTIONS)[number]

export const MOTION_INTENSITY = { subtle: 0.06, medium: 0.1 } as const
export type MotionIntensity = keyof typeof MOTION_INTENSITY

/**
 * Sequência de movimentos alternados (seção 8.6), nunca dois iguais seguidos.
 * Determinística por semente (o mesmo vídeo sempre recebe a mesma sequência).
 */
export function pickMotions(count: number, seed: string, previous: Motion | null = null): Motion[] {
  let x = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1
  const rand = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
  const out: Motion[] = []
  let prev = previous
  for (let i = 0; i < count; i++) {
    const options = MOTIONS.filter((m) => m !== prev)
    const m = options[Math.floor(rand() * options.length)]!
    out.push(m)
    prev = m
  }
  return out
}

/**
 * Filtro `zoompan` sobre a imagem 4K (3840×2160) gerando `frames` quadros em
 * 1920×1080. A imagem é decodificada uma vez; a origem 2× maior evita o tremor
 * do arredondamento de x/y.
 */
export function zoompanFilter(
  motion: Motion,
  frames: number,
  intensity: number,
  fps: number,
  /** Continuação de um movimento já iniciado (crossfade): quadro inicial e duração original. */
  cont?: { fromFrame: number; span: number },
  w = 1920,
  h = 1080,
): string {
  const D = Math.max(1, (cont?.span ?? frames) - 1)
  const a = intensity.toFixed(4)
  // progresso 0→1 (na continuação passa um pouco de 1, seguindo o mesmo ritmo)
  const p = cont ? `min((on+${cont.fromFrame})/${D}\\,1.2)` : `min(on/${D}\\,1)`
  const center = { x: `(iw-iw/zoom)/2`, y: `(ih-ih/zoom)/2` }
  let z: string
  let x: string
  const y = center.y
  switch (motion) {
    case 'zoom_in':
      z = `1+${a}*${p}`
      x = center.x
      break
    case 'zoom_out':
      z = `1+${a}*(1-${p})`
      x = center.x
      break
    case 'pan_left':
      z = `1+${a}`
      x = `(iw-iw/zoom)*(1-${p})`
      break
    case 'pan_right':
      z = `1+${a}`
      x = `(iw-iw/zoom)*${p}`
      break
  }
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps}`
}
