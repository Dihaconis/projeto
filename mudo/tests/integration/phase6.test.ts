import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, runCli } from '../../src/cli/run'
import {
  Runner,
  consumeQuota,
  createChannel,
  createVideoJob,
  jobHandlers,
  licensesCsv,
  listChannels,
  monthKey,
  nullLogger,
  quotaStatus,
  removeChannel,
  resolveMediaBinaries,
  scriptSimilarity,
  setPlan,
  setSetting,
  testConnection,
  updateChannel,
  videoLicenses,
} from '../../src/core'
import { PLANS } from '../../src/shared/plans'
import { MIGRATIONS_DIR, makeEnv, waitFor, type TestEnv, slow } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureStock, fixtureTts } from '../helpers/fixtures'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
  setSetting(env.handle, 'output.dir', path.join(env.paths.root, 'saída'))
})
afterEach(() => env.cleanup())

async function generate(channelId: string) {
  const { video, job } = createVideoJob(env.handle, { channelId, theme: 'Por que o céu é azul', durationS: 60 })
  const r = new Runner({ handle: env.handle, paths: env.paths, log: nullLogger(), handlers: jobHandlers, providers: fixtureSource([fixtureLlm()], [fixtureTts()], { stock: [fixtureStock('pexels')] }), media: resolveMediaBinaries(), pollMs: 20 })
  r.start()
  const j = await waitFor(() => {
    const x = r.queue.get(job.id)
    return x && ['done', 'failed', 'needs_input'].includes(x.state) ? x : null
  }, slow(180_000))
  await r.stop()
  return { video, job: j }
}

describe('cota (seção 12)', () => {
  it('planos vêm de plans.ts; uso pessoal é ilimitado; estouro recusa antes de enfileirar; consumo só em done', async () => {
    expect(PLANS.map((p) => [p.id, p.videosPerMonth, p.cutsPerMonth])).toEqual([
      ['ilimitado', null, null],
      ['inicial', 6, 5],
      ['pro', 30, 20],
      ['elite', 100, 100],
    ])
    expect(quotaStatus(env.handle)).toMatchObject({ videosLimit: null, videosRemaining: null })
    const ch = createChannel(env.handle, { name: 'C', niche: 'n', language: 'pt-BR' })
    setPlan(env.handle, 'inicial')
    for (let i = 0; i < 5; i++) consumeQuota(env.handle, 'video')
    const { job } = await generate(ch.id) // 6º do mês: ainda cabe
    expect(job.state).toBe('done')
    expect(quotaStatus(env.handle)).toMatchObject({ videosUsed: 6, videosRemaining: 0, month: monthKey() })
    expect(() => createVideoJob(env.handle, { channelId: ch.id, theme: 'Mais um', durationS: 60 })).toThrow(/esgotada/)
    expect(env.handle.sqlite.prepare('SELECT COUNT(*) n FROM videos').get()).toEqual({ n: 1 }) // nada foi criado
  }, slow(200_000))

  it('vídeos em produção contam para não estourar; CLI devolve código 3', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'n', language: 'pt-BR' })
    setPlan(env.handle, 'inicial')
    for (let i = 0; i < 5; i++) consumeQuota(env.handle, 'video')
    createVideoJob(env.handle, { channelId: ch.id, theme: 'Um em produção', durationS: 60 })
    expect(quotaStatus(env.handle)).toMatchObject({ videosPending: 1, videosRemaining: 0 })
    const err: string[] = []
    const code = await runCli(['generate', '--theme', 'Outro tema', '--channel', ch.id], {
      dataRoot: env.paths.root,
      migrationsDir: MIGRATIONS_DIR,
      providers: () => fixtureSource([fixtureLlm()], [fixtureTts()]),
      media: resolveMediaBinaries(),
      io: { out: () => undefined, err: (s) => err.push(s), readStdin: async () => '' },
    })
    expect(code).toBe(EXIT.quota)
    expect(err.join('')).toContain('restam 0')
  })
})

describe('repetição entre vídeos do canal (seção 10)', () => {
  it('mede estrutura em comum; roteiro igual a um recente reprova e pede ação', async () => {
    const a = 'Você olha para cima e vê azul. Mas a luz é branca. O ar espalha o azul.'
    expect(scriptSimilarity(a, a)).toBe(1)
    expect(scriptSimilarity(a, 'Polvos têm três corações e sangue azul. Eles aprendem rápido.')).toBeLessThan(0.1)

    setSetting(env.handle, 'review.maxSimilarity', 0.3)
    const ch = createChannel(env.handle, { name: 'C', niche: 'n', language: 'pt-BR' })
    expect((await generate(ch.id)).job.state).toBe('done')
    const second = await generate(ch.id) // a fixture devolve o mesmo roteiro
    expect(second.job.state).toBe('needs_input')
    expect(second.job.lastError).toMatchObject({ code: 'REVIEW_REJECTED' })
    expect((second.job.lastError as { message: string }).message).toContain('semelhança')
  }, slow(300_000))
})

describe('canais e licenças (seção 9 e 11)', () => {
  it('editar canal; remover canal com vídeos arquiva', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'n', language: 'pt-BR' })
    const up = updateChannel(env.handle, ch.id, { name: 'Novo nome', niche: 'história', language: 'es', musicMood: 'dramatic', stylePreset: { highlightColor: '#FF0000', motionIntensity: 'medium' } })
    expect(up).toMatchObject({ name: 'Novo nome', language: 'es', musicMood: 'dramatic' })
    expect(() => updateChannel(env.handle, ch.id, { name: '', niche: 'x', language: 'es' })).toThrow()
    const empty = createChannel(env.handle, { name: 'Vazio', niche: 'n', language: 'pt-BR' })
    expect(removeChannel(env.handle, empty.id)).toBe('deleted')
    createVideoJob(env.handle, { channelId: ch.id, theme: 'Tema', durationS: 60 })
    expect(removeChannel(env.handle, ch.id)).toBe('archived')
    expect(listChannels(env.handle)).toHaveLength(0)
  })

  it('licenças por vídeo com fonte, autor, origem, crédito e situação; CSV', async () => {
    const ch = createChannel(env.handle, { name: 'C', niche: 'n', language: 'pt-BR' })
    const { video } = await generate(ch.id)
    const entries = videoLicenses(env.handle, video.id)
    const imgs = entries.filter((e) => e.kind === 'image')
    expect(imgs.length).toBeGreaterThan(5)
    expect(imgs.every((e) => e.license === 'pexels' && e.status === 'ok' && e.author && e.sourceUrl && e.scenes.length > 0)).toBe(true)
    expect(entries.find((e) => e.kind === 'music')).toMatchObject({ license: 'own', source: 'MUDO (trilha embutida)' })
    const csv = licensesCsv(env.handle, [video.id])
    expect(csv.startsWith('﻿video_id,titulo,tipo')).toBe(true)
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(entries.length + 1)
    expect(csv).toContain('Por que o céu é azul? A resposta em um minuto')

    // crédito faltando aparece como pendência e bloqueia a montagem
    env.handle.sqlite.prepare("UPDATE images SET credit_text = NULL WHERE source = 'pexels'").run()
    expect(videoLicenses(env.handle, video.id).filter((e) => e.status === 'missing_credit').length).toBe(imgs.length)
  }, slow(200_000))
})

describe('testar conexão', () => {
  it('ok, chave recusada e sem resposta viram mensagens claras (sem expor a chave)', async () => {
    let status = 200
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await testConnection('openai', 'sk-x', { baseURL: base })).toMatchObject({ ok: true })
      status = 401
      const bad = await testConnection('elevenlabs', 'sk-segredo', { baseURL: base })
      expect(bad).toMatchObject({ ok: false })
      expect(bad.message).toContain('recusada')
      expect(bad.message).not.toContain('sk-segredo')
      expect(await testConnection('azure_speech', 'k')).toMatchObject({ ok: false, message: expect.stringContaining('região') })
    } finally {
      server.close()
    }
  })
})
