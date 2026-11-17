import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobToVec } from '../../src/core/images/embeddings'
import { findLocalMatch, importFolder, importImageFile, preparedFrame, recencyPenalty, setImageLicense } from '../../src/core/images/library'
import { hamming, isSameImage, phash } from '../../src/core/images/phash'
import { RateLimiter } from '../../src/core/images/stock'
import { makeEnv, type TestEnv } from '../helpers/env'
import { fixtureEmbeddings, noiseImage } from '../helpers/fixtures'

let env: TestEnv
let dir: string
beforeEach(() => {
  env = makeEnv()
  dir = path.join(env.paths.root, 'acervo com espaço ção')
  fs.mkdirSync(dir, { recursive: true })
})
afterEach(() => env.cleanup())

async function put(name: string, seed: string, w = 1920, h = 1080) {
  const f = path.join(dir, name)
  fs.writeFileSync(f, await noiseImage(seed, w, h))
  return f
}

describe('pHash', () => {
  it('mesma foto redimensionada/recomprimida ≈ igual; fotos diferentes ≠', async () => {
    const a = await noiseImage('a', 1920, 1080)
    const aSmall = await sharp(a).resize(640, 360).jpeg({ quality: 50 }).toBuffer()
    const b = await noiseImage('b', 1920, 1080)
    const [ha, has, hb] = await Promise.all([phash(a), phash(aSmall), phash(b)])
    expect(ha).toMatch(/^[0-9a-f]{16}$/)
    expect(hamming(ha, has)).toBeLessThanOrEqual(4)
    expect(isSameImage(ha, has)).toBe(true)
    expect(hamming(ha, hb)).toBeGreaterThan(16)
    expect(isSameImage(ha, hb)).toBe(false)
  })
})

describe('acervo local (seção 9)', () => {
  it('importa com licença, recusa < 1280 px, sem licença fica em quarentena', async () => {
    await put('clear blue sky over a field.jpg', 's1')
    await put('mini.jpg', 's2', 800, 450)
    fs.writeFileSync(path.join(dir, 'leia-me.txt'), 'x')
    const r = await importFolder(env.handle, fixtureEmbeddings, dir, { license: 'own' })
    expect(r.map((x) => x.status).sort()).toEqual(['imported', 'rejected'])
    expect(r.find((x) => x.status === 'rejected')?.reason).toContain('1280')

    const q = await importImageFile(env.handle, fixtureEmbeddings, await put('sem licenca.jpg', 's3'))
    expect(q).toMatchObject({ status: 'imported', quarantined: true })
    const row = env.handle.sqlite.prepare('SELECT license, phash, embedding_model, embedding FROM images WHERE id = ?').get(q.id) as {
      license: string | null
      phash: string
      embedding_model: string
      embedding: Buffer
    }
    expect(row.license).toBeNull()
    expect(row.phash).toMatch(/^[0-9a-f]{16}$/)
    expect(row.embedding_model).toBe(fixtureEmbeddings.model)
    expect(blobToVec(row.embedding)?.length).toBe(128)

    // licença por arquivo tira da quarentena; crédito informado entra na cartela
    const upd = setImageLicense(env.handle, q.id!, 'cc0', 'Foto: Fulana')
    expect(upd).toMatchObject({ license: 'cc0', requiresCredit: true, creditText: 'Foto: Fulana' })
    expect(() => setImageLicense(env.handle, 'nao-existe', 'own')).toThrow()
  })

  it('busca: melhor cosseno acima do limiar; ignora quarentena, já usadas (id e pHash) e crédito faltando', async () => {
    const sky = await importImageFile(env.handle, fixtureEmbeddings, await put('blue sky clouds.jpg', 'sky'), { license: 'own' })
    const skyCopy = await importImageFile(env.handle, fixtureEmbeddings, await put('blue sky clouds copy.jpg', 'sky'), { license: 'own' }) // mesma foto
    await importImageFile(env.handle, fixtureEmbeddings, await put('blue sky quarantine.jpg', 'q'))
    await importImageFile(env.handle, fixtureEmbeddings, await put('ocean waves.jpg', 'sea'), { license: 'cc0' })
    const [q] = await fixtureEmbeddings.embedTexts(['blue sky clouds'])
    const base = { model: fixtureEmbeddings.model, query: q!, threshold: 0.3 }

    const first = findLocalMatch(env.handle, { ...base, usedIds: new Set(), usedPhashes: [] })
    expect([sky.id, skyCopy.id]).toContain(first?.row.id)
    const skyHash = (env.handle.sqlite.prepare('SELECT phash FROM images WHERE id = ?').get(sky.id) as { phash: string }).phash
    // a cópia tem outro id, mas é a mesma foto: não pode repetir no vídeo
    expect(findLocalMatch(env.handle, { ...base, usedIds: new Set([sky.id!]), usedPhashes: [skyHash] })).toBeNull()

    env.handle.sqlite.prepare('UPDATE images SET requires_credit = 1, credit_text = NULL').run()
    expect(findLocalMatch(env.handle, { ...base, usedIds: new Set(), usedPhashes: [] })).toBeNull()
  })

  it('penalidade de uso recente só nos últimos 30 dias', () => {
    const now = Date.now()
    expect(recencyPenalty(3, now - 86_400_000, now)).toBeCloseTo(0.06)
    expect(recencyPenalty(50, now - 86_400_000, now)).toBe(0.1)
    expect(recencyPenalty(3, now - 31 * 86_400_000, now)).toBe(0)
    expect(recencyPenalty(0, null, now)).toBe(0)
  })

  it('quadro preparado: 4K 16:9 com recorte inteligente, cacheado', async () => {
    const f = await put('retrato.jpg', 'portrait', 1400, 2000)
    const out = await preparedFrame(env.paths, { id: 'img-1', path: f })
    const m = await sharp(out).metadata()
    expect([m.width, m.height]).toEqual([3840, 2160])
    const mtime = fs.statSync(out).mtimeMs
    await preparedFrame(env.paths, { id: 'img-1', path: f })
    expect(fs.statSync(out).mtimeMs).toBe(mtime)
  })
})

describe('limite de requisições', () => {
  it('espera a janela liberar; não segura o job por mais de 1 min', async () => {
    let t = 0
    const rl = new RateLimiter(2, 1000, () => t)
    const sig = new AbortController().signal
    await rl.acquire(sig)
    await rl.acquire(sig)
    const p = rl.acquire(sig)
    t = 1001
    await p
    const slow = new RateLimiter(1, 3_600_000, () => 0)
    await slow.acquire(sig)
    await expect(slow.acquire(sig)).rejects.toMatchObject({ status: 429 })
  })
})
