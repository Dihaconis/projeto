import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

export const TITLE_FONT = { family: 'Anton', file: 'Anton-Regular.ttf' }
export const BODY_FONT = { family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf' }

function escapeMarkup(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)
}

/** Texto renderizado pelo Pango com a fonte embarcada (OFL). */
async function textImage(
  fontsDir: string,
  font: { family: string; file: string },
  markup: string,
  size: number,
  width: number,
  align: 'left' | 'centre' = 'left',
): Promise<Buffer> {
  return sharp({
    text: {
      text: markup,
      font: `${font.family} ${size}`,
      fontfile: path.join(fontsDir, font.file),
      rgba: true,
      width,
      wrap: 'word',
      align,
      spacing: Math.round(size * 0.05),
    },
  })
    .png()
    .toBuffer()
}

/** "Força" visual para escolher a imagem da thumbnail: entropia + contraste. */
export async function imageStrength(file: string): Promise<number> {
  const s = await sharp(file).resize(320, 180, { fit: 'cover' }).stats()
  const contrast = s.channels.reduce((a, c) => a + c.stdev, 0) / s.channels.length
  return s.entropy * 10 + contrast
}

/**
 * Thumbnails 1280×720 (seção 8.6): overlay escuro em gradiente e título curto
 * (≤ 5 palavras) em caixa alta com fonte grossa. Duas variações.
 */
export async function renderThumbnails(o: {
  fontsDir: string
  images: string[]
  title: string
  highlight: string
  out: [string, string]
}): Promise<void> {
  const W = 1280
  const H = 720
  const title = o.title.trim().split(/\s+/).slice(0, 5).join(' ').toLocaleUpperCase()
  const words = title.split(' ')
  const lastWord = words.pop() ?? ''
  const rest = words.join(' ')

  // variação 1: imagem mais forte, gradiente na base, texto à esquerda com a última palavra em destaque
  const img1 = o.images[0]!
  const grad1 = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0.25" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.9"/></linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/></svg>`,
  )
  const t1 = await textImage(
    o.fontsDir,
    TITLE_FONT,
    `<span foreground="#FFFFFF">${escapeMarkup(rest)}${rest ? ' ' : ''}</span><span foreground="${o.highlight}">${escapeMarkup(lastWord)}</span>`,
    124,
    W - 140,
  )
  const t1m = await sharp(t1).metadata()
  await sharp(img1)
    .rotate()
    .resize(W, H, { fit: 'cover', position: sharp.strategy.attention })
    .modulate({ saturation: 1.15 })
    .composite([
      { input: grad1, top: 0, left: 0 },
      { input: t1, left: 70, top: Math.max(20, H - (t1m.height ?? 200) - 60) },
    ])
    .jpeg({ quality: 90 })
    .toFile(o.out[0])

  // variação 2: outra imagem (se houver), escurecida por igual, texto centralizado e faixa de cor
  const img2 = o.images[1] ?? img1
  const dark = Buffer.from(`<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="#000" fill-opacity="0.55"/></svg>`)
  const bar = Buffer.from(`<svg width="${W}" height="16"><rect width="100%" height="100%" fill="${o.highlight}"/></svg>`)
  const t2 = await textImage(o.fontsDir, TITLE_FONT, `<span foreground="#FFFFFF">${escapeMarkup(title)}</span>`, 132, W - 160, 'centre')
  const t2m = await sharp(t2).metadata()
  await sharp(img2)
    .rotate()
    .resize(W, H, { fit: 'cover', position: sharp.strategy.entropy })
    .composite([
      { input: dark, top: 0, left: 0 },
      { input: t2, left: Math.round((W - (t2m.width ?? W)) / 2), top: Math.round((H - (t2m.height ?? 200)) / 2) },
      { input: bar, left: 0, top: H - 16 },
    ])
    .jpeg({ quality: 90 })
    .toFile(o.out[1])
}

export const CREDIT_LINES_PER_PAGE = 9

/**
 * Páginas da cartela final de créditos (seção 8.7), em 4K para passar pelo
 * mesmo zoompan dos segmentos. Retorna os caminhos das páginas.
 */
export async function renderCreditPages(o: { fontsDir: string; heading: string; lines: string[]; footer: string; dir: string }): Promise<string[]> {
  const W = 3840
  const H = 2160
  fs.mkdirSync(o.dir, { recursive: true })
  const pages: string[][] = []
  for (let i = 0; i < Math.max(1, o.lines.length); i += CREDIT_LINES_PER_PAGE) pages.push(o.lines.slice(i, i + CREDIT_LINES_PER_PAGE))
  const out: string[] = []
  for (let p = 0; p < pages.length; p++) {
    const heading = await textImage(o.fontsDir, TITLE_FONT, `<span foreground="#FFFFFF">${escapeMarkup(o.heading.toLocaleUpperCase())}</span>`, 150, W - 600, 'centre')
    const body = await textImage(
      o.fontsDir,
      BODY_FONT,
      `<span foreground="#E6E8EB">${pages[p]!.map(escapeMarkup).join('\n')}</span>`,
      54,
      W - 600,
      'centre',
    )
    const footer = await textImage(o.fontsDir, BODY_FONT, `<span foreground="#9AA1AB">${escapeMarkup(o.footer)}</span>`, 44, W - 600, 'centre')
    const [hm, bm, fm] = await Promise.all([heading, body, footer].map((b) => sharp(b).metadata()))
    const file = path.join(o.dir, `credits-${p + 1}.png`)
    await sharp({ create: { width: W, height: H, channels: 3, background: '#0b0d10' } })
      .composite([
        { input: heading, left: Math.round((W - (hm!.width ?? 0)) / 2), top: 260 },
        { input: body, left: Math.round((W - (bm!.width ?? 0)) / 2), top: 260 + (hm!.height ?? 0) + 140 },
        { input: footer, left: Math.round((W - (fm!.width ?? 0)) / 2), top: H - (fm!.height ?? 0) - 220 },
      ])
      .png()
      .toFile(file)
    out.push(file)
  }
  return out
}
