/**
 * CLIP local de verdade (offline): exige `npm run models` (baixa e confere o
 * hash dos arquivos em resources/models). Sem o modelo, o teste falha com a
 * instrução — não é pulado.
 */
import path from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { clipLocal, cosine } from '../../src/core/images/embeddings'
import { slow } from '../helpers/env'

const MODELS = path.resolve(__dirname, '../../resources/models')

describe('CLIP local (offline)', () => {
  it('texto e imagem no mesmo espaço; a cor certa fica mais perto', async () => {
    const clip = clipLocal(MODELS)
    const [red, blue, cat] = await clip.embedTexts(['a plain red image', 'a plain blue image', 'a photo of a cat'])
    expect(red!.length).toBe(512)
    const redImg = await clip.embedImage!(await sharp({ create: { width: 640, height: 360, channels: 3, background: '#d01010' } }).png().toBuffer())
    const blueImg = await clip.embedImage!(await sharp({ create: { width: 640, height: 360, channels: 3, background: '#1030d0' } }).png().toBuffer())
    expect(cosine(red!, redImg)).toBeGreaterThan(cosine(blue!, redImg))
    expect(cosine(blue!, blueImg)).toBeGreaterThan(cosine(red!, blueImg))
    expect(cosine(red!, redImg)).toBeGreaterThan(cosine(cat!, redImg))
    expect(clip.model).toContain('clip-vit-base-patch32')
  }, slow(60_000))
})
