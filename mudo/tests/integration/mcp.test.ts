/**
 * Servidor MCP (seção 14) pelo cliente oficial do SDK, num transporte em
 * memória: as 5 ferramentas, geração assíncrona até o MP4 com provedores de
 * fixture, idempotency_key, erros com código e cota.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, runCli, type CliDeps } from '../../src/cli/run'
import { consumeQuota, openDatabase, quotaStatus, resolveMediaBinaries, setPlan, type ProviderSource } from '../../src/core'
import { MIGRATIONS_DIR, rmTemp, slow, tempRoot } from '../helpers/env'
import { fixtureLlm, fixtureSource, fixtureTts, type FixtureLog } from '../helpers/fixtures'

let root: string
let client: Client
let server: Promise<number>
let log: FixtureLog

async function start(providers: ProviderSource) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const deps: CliDeps = {
    dataRoot: path.join(root, 'dados'),
    migrationsDir: MIGRATIONS_DIR,
    providers: () => providers,
    media: resolveMediaBinaries(),
    io: { out: () => undefined, err: () => undefined, readStdin: async () => '' },
    pollMs: 20,
    mcpTransport: () => serverT,
    version: '0.1.0-teste',
  }
  // grava a pasta de saída antes (mesma base de dados que o servidor usa)
  expect(await runCli(['config', 'set', 'output.dir', path.join(root, 'saída')], deps)).toBe(EXIT.ok)
  server = runCli(['mcp'], deps)
  client = new Client({ name: 'teste', version: '1.0.0' })
  await client.connect(clientT)
}

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> }
async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args })) as Result
  // o texto é o mesmo JSON do structuredContent (clientes que só leem texto)
  expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent)
  return r
}

beforeEach(async () => {
  root = tempRoot('mudo mcp ação ')
  log = { calls: [] }
  await start(fixtureSource([fixtureLlm('fixture-llm', log)], [fixtureTts('fixture-tts', log)]))
})
afterEach(async () => {
  await client.close()
  expect(await server).toBe(EXIT.ok) // fechar o cliente encerra o servidor e o runner
  rmTemp(root)
})

describe('servidor MCP', () => {
  it('lista as 5 ferramentas com esquema de entrada', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['channel_create', 'cost_estimate', 'generate_video', 'job_status', 'library_list'])
    const gen = tools.find((t) => t.name === 'generate_video')!
    expect(gen.inputSchema.required).toEqual(expect.arrayContaining(['theme', 'channel_id']))
    expect(Object.keys(gen.inputSchema.properties ?? {})).toContain('idempotency_key')
    expect(tools.find((t) => t.name === 'job_status')!.annotations?.readOnlyHint).toBe(true)
  })

  it('canal → estimativa → geração assíncrona até o MP4; mesma idempotency_key não duplica', async () => {
    const ch = await call('channel_create', { name: 'Ciência Já', niche: 'ciência do dia a dia', language: 'pt-BR' })
    expect(ch.isError).toBeFalsy()
    const channelId = ch.structuredContent!.channelId as string

    const est = await call('cost_estimate', { theme: 'Por que o céu é azul', channel_id: channelId, duration_s: 60 })
    expect(est.structuredContent!.totalCents).toBeGreaterThan(0)

    const req = { theme: 'Por que o céu é azul', channel_id: channelId, duration_s: 60, idempotency_key: 'pedido-0001' }
    const g = await call('generate_video', req)
    expect(g.isError).toBeFalsy()
    // devolve na hora, antes de terminar
    expect(['queued', 'running']).toContain(g.structuredContent!.state)
    expect(g.structuredContent!.reused).toBe(false)
    const jobId = g.structuredContent!.jobId as string

    const again = await call('generate_video', req)
    expect(again.structuredContent).toMatchObject({ jobId, reused: true })
    const conflict = await call('generate_video', { ...req, theme: 'Outro tema qualquer' })
    expect(conflict.isError).toBe(true)
    expect(conflict.structuredContent!.error).toMatchObject({ code: 'INVALID_INPUT' })

    const deadline = Date.now() + slow(240_000)
    let done: Record<string, unknown>
    for (;;) {
      done = (await call('job_status', { job_id: jobId })).structuredContent!
      if (['done', 'failed', 'needs_input'].includes(done.state as string)) break
      if (Date.now() > deadline) throw new Error(`tempo esgotado; estado ${String(done.state)}`)
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(done).toMatchObject({ state: 'done', error: null })
    expect(fs.existsSync(done.outputPath as string)).toBe(true)
    // uma só geração apesar do pedido repetido
    expect(log.calls.filter((c) => c.kind === 'script').length).toBe(1)

    const lib = await call('library_list', {})
    expect(lib.structuredContent!.videos).toEqual([expect.objectContaining({ title: done.title, outputPath: done.outputPath, channelId })])
    // repetir depois de pronto também devolve o mesmo vídeo, sem gerar outro
    expect((await call('generate_video', req)).structuredContent).toMatchObject({ jobId, reused: true, state: 'done' })
  }, slow(300_000))

  it('erros voltam como resultado com código: job inexistente, canal inexistente, entrada inválida, cota', async () => {
    const nf = await call('job_status', { job_id: 'nao-existe' })
    expect(nf.isError).toBe(true)
    expect(nf.structuredContent!.error).toMatchObject({ code: 'INVALID_INPUT' })

    const noCh = await call('generate_video', { theme: 'Tema válido', channel_id: 'nao-existe' })
    expect(noCh.structuredContent!.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('canal') })

    const bad = (await client.callTool({ name: 'generate_video', arguments: { theme: 'x', channel_id: 'c' } })) as Result
    expect(bad.isError).toBe(true)

    const ch = (await call('channel_create', { name: 'Canal', niche: 'nicho', language: 'es' })).structuredContent!
    const db = openDatabase(path.join(root, 'dados', 'mudo.db'))
    setPlan(db, 'inicial')
    for (let i = 0; i < quotaStatus(db).plan.videosPerMonth!; i++) consumeQuota(db, 'video')
    db.close()
    const q = await call('generate_video', { theme: 'Tema válido', channel_id: ch.channelId })
    expect(q.isError).toBe(true)
    expect(q.structuredContent!.error).toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })
})
