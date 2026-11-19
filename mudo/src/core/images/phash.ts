import sharp from 'sharp'

const N = 32
const K = 8

/** Tabela de cossenos da DCT-II 32×32 (calculada uma vez). */
const COS: number[][] = Array.from({ length: K }, (_, u) =>
  Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))),
)

/**
 * pHash de 64 bits (seção 8.4): reduz para 32×32 em cinza, DCT, pega o bloco
 * 8×8 de baixa frequência e compara cada coeficiente com a mediana. Resiste a
 * redimensionamento, recompressão e pequenos ajustes — "mesma foto" mesmo com
 * ids diferentes.
 */
export async function phash(input: string | Buffer): Promise<string> {
  const px = await sharp(input).rotate().greyscale().resize(N, N, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  const rows: number[][] = []
  for (let y = 0; y < N; y++) {
    const r: number[] = []
    for (let u = 0; u < K; u++) {
      let s = 0
      for (let x = 0; x < N; x++) s += px[y * N + x]! * COS[u]![x]!
      r.push(s)
    }
    rows.push(r)
  }
  const coeffs: number[] = []
  for (let v = 0; v < K; v++) {
    for (let u = 0; u < K; u++) {
      let s = 0
      for (let y = 0; y < N; y++) s += rows[y]![u]! * COS[v]![y]!
      coeffs.push(s)
    }
  }
  const ac = coeffs.slice(1) // ignora o termo DC (brilho médio)
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)]!
  let bits = 0n
  for (const c of coeffs) bits = (bits << 1n) | (c > median ? 1n : 0n)
  return bits.toString(16).padStart(16, '0')
}

/** Distância de Hamming entre dois pHash hexadecimais. */
export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let n = 0
  while (x > 0n) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

/** Até esta distância, duas imagens contam como a mesma foto. */
export const SAME_IMAGE_MAX_DISTANCE = 8

export function isSameImage(a: string | null, b: string | null): boolean {
  return !!a && !!b && hamming(a, b) <= SAME_IMAGE_MAX_DISTANCE
}
