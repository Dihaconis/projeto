import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProviderRefusalError } from '../../src/core'
import { openAiImages, pexels, pixabay } from '../../src/core/images/stock'

type Req = { url: string; headers: http.IncomingHttpHeaders; body: string }
let handler: (r: Req) => { status: number; body: string } = () => ({ status: 500, body: '' })
let last: Req | null = null
let server: http.Server
let base = ''
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      last = { url: req.url ?? '', headers: req.headers, body }
      const r = handler(last)
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
const sig = () => new AbortController().signal

describe('bancos de imagem', () => {
  it('Pexels: chave no Authorization, paisagem; guarda autor e URL de origem', async () => {
    handler = () => ({
      status: 200,
      body: JSON.stringify({
        photos: [
          {
            id: 42, width: 4000, height: 2600, url: 'https://www.pexels.com/photo/42/', photographer: 'Ana Lima', photographer_url: 'https://www.pexels.com/@ana', alt: 'blue sky',
            src: { original: 'https://images.pexels.com/42.jpg', large2x: 'https://images.pexels.com/42.jpg?w=1880', medium: 'https://images.pexels.com/42.jpg?h=350' },
          },
        ],
      }),
    })
    const p = pexels({ apiKey: 'pk', baseURL: base })
    const r = await p.call({ query: 'blue sky', perPage: 15 }, sig())
    expect(last!.headers.authorization).toBe('pk')
    expect(last!.url).toContain('orientation=landscape')
    expect(r.candidates[0]).toMatchObject({ sourceId: '42', author: 'Ana Lima', pageUrl: 'https://www.pexels.com/photo/42/', width: 4000 })
    expect(p.credit(r.candidates[0]!)).toContain('Ana Lima')
    expect(p.license).toBe('pexels')
  })

  it('Pixabay: chave vai na query (exigência da API) mas nunca aparece em mensagem de erro', async () => {
    handler = () => ({ status: 200, body: JSON.stringify({ hits: [{ id: 7, pageURL: 'https://pixabay.com/p-7/', tags: 'sky, cloud', webformatURL: 'w', largeImageURL: 'l', imageWidth: 1920, imageHeight: 1280, user: 'joao', user_id: 1 }] }) })
    const p = pixabay({ apiKey: 'segredo-pixabay', baseURL: `${base}/api/` })
    const r = await p.call({ query: 'sky', perPage: 10 }, sig())
    expect(last!.url).toContain('min_width=1280')
    expect(r.candidates[0]).toMatchObject({ sourceId: '7', author: 'joao', description: 'sky, cloud' })
    handler = () => ({ status: 400, body: '[ERROR 400] "key" segredo-pixabay invalid' })
    const e = await p.call({ query: 'sky', perPage: 10 }, sig()).catch((x) => x)
    expect(String(e.message)).not.toContain('segredo-pixabay')
  })

  it('OpenAI Images: bloqueio de moderação vira recusa (needs_input, sem troca automática)', async () => {
    handler = () => ({ status: 200, body: JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }) })
    const g = openAiImages({ apiKey: 'k', baseURL: base })
    expect((await g.call({ prompt: 'sky' }, sig())).image.toString()).toBe('png')
    expect(JSON.parse(last!.body).size).toBe('1536x1024')
    handler = () => ({ status: 400, body: JSON.stringify({ error: { code: 'moderation_blocked' } }) })
    await expect(g.call({ prompt: 'x' }, sig())).rejects.toBeInstanceOf(ProviderRefusalError)
  })
})
