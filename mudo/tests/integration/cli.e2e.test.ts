/**
 * E2E da CLI com provedores de fixture (critério de aceite 11): gera um MP4
 * real de ~60 s com ffmpeg e confere formato, metadado de IA, .txt, custo,
 * fallback e recusa.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_DISCLOSURE_METADATA } from '../../src/shared/enums'
import { EXIT, runCli, type CliDeps } from '../../src/cli/run'
import { openDatabase, resolveMediaBinaries, type ProviderSource } from '../../src/core'
import { MIGRATIONS_DIR, tempRoot } from '../helpers/env'
import { downLlm, fixtureLlm, fixtureSource, fixtureTts, refusingLlm, type FixtureLog } from '../helpers/fixtures'

let root: string
let outDir: string

beforeEach(() => {
  root = tempRoot('mudo cli ação ')
  outDir = path.join(root, 'saída de vídeos')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function cli(providers: ProviderSource) {
  const out: string[] = []
  const err: string[] = []
  const deps: CliDeps = {
    dataRoot: path.join(root, 'dados'),
    migrationsDir: MIGRATIONS_DIR,
    providers: () => providers,
    media: resolveMediaBinaries(),
    io: { out: (s) => out.push(s), err: (s) => err.push(s), readStdin: async () => '' },
    pollMs: 50,
  }
  return {
    run: async (...argv: string[]) => {
      out.length = 0
      err.length = 0
      const code = await runCli(argv, deps)
      return { code, out: out.join(''), err: err.join('') }
    },
  }
}

async function setup(providers: ProviderSource) {
  const c = cli(providers)
  expect((await c.run('config', 'set', 'output.dir', outDir)).code).toBe(EXIT.ok)
  const ch = await c.run('channel', 'create', '--name', 'Ciência em 1 Minuto', '--niche', 'ciência do dia a dia', '--lang', 'pt-BR', '--json')
  expect(ch.code).toBe(EXIT.ok)
  const channelId = JSON.parse(ch.out).channelId as string
  return { c, channelId }
}

function ffprobe(file: string) {
  const { ffprobe } = resolveMediaBinaries()
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' })
  return JSON.parse(r.stdout) as {
    format: { duration: string; tags?: Record<string, string> }
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; bit_rate?: string }>
  }
}

describe('CLI mudo (fixtures)', () => {
  it('generate --wait produz MP4 1920x1080/30fps H.264+AAC de ~60 s, .txt e metadado de IA', async () => {
    const log: FixtureLog = { calls: [] }
    const { c, channelId } = await setup(fixtureSource([fixtureLlm('fixture-llm', log)], [fixtureTts('fixture-tts', log)]))

    const est = await c.run('estimate', '--theme', 'Por que o céu é azul', '--channel', channelId, '--duration', '60', '--json')
    expect(est.code).toBe(EXIT.ok)
    expect(JSON.parse(est.out).totalCents).toBeGreaterThan(0)

    const g = await c.run('generate', '--theme', 'Por que o céu é azul', '--channel', channelId, '--duration', '60', '--wait', '--json')
    expect(g.err).toBe('')
    expect(g.out).toContain('"state":"done"')
    expect(g.code).toBe(EXIT.ok)
    const s = JSON.parse(g.out)
    expect(s).toMatchObject({ state: 'done', stage: 'assemble', progress: 1, error: null })
    expect(s.title).toBe('Por que o céu é azul? A resposta em um minuto')
    expect(s.costCents).toBeGreaterThan(0)
    expect(s.genTimeS).toBeGreaterThan(0)
    expect(fs.existsSync(s.outputPath)).toBe(true)
    expect(path.dirname(s.outputPath)).toBe(outDir)

    const p = ffprobe(s.outputPath)
    const v = p.streams.find((x) => x.codec_type === 'video')!
    const a = p.streams.find((x) => x.codec_type === 'audio')!
    expect(v).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1' })
    expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000' })
    const dur = Number(p.format.duration)
    expect(dur).toBeGreaterThan(51)
    expect(dur).toBeLessThan(69)
    expect(Math.abs(dur - s.actualDurationS)).toBeLessThan(0.2)
    expect(p.format.tags?.comment).toBe(AI_DISCLOSURE_METADATA)

    const txt = fs.readFileSync(s.outputPath.replace(/\.mp4$/, '.txt'), 'utf8')
    expect(txt).toContain(s.title)
    expect(txt).toContain('Créditos:')
    expect(txt).toContain('IA')

    // status e biblioteca leem os mesmos valores
    const st = await c.run('status', s.jobId, '--json')
    expect(JSON.parse(st.out)).toEqual(s)
    const lib = await c.run('library', 'list', '--json')
    const items = JSON.parse(lib.out)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ videoId: s.videoId, outputPath: s.outputPath, costCents: s.costCents })

    // registro de chamadas por etapa
    const h = openDatabase(path.join(root, 'dados', 'mudo.db'))
    const stages = h.sqlite.prepare("SELECT stage, outcome, COUNT(*) n FROM provider_log GROUP BY stage, outcome ORDER BY stage").all()
    expect(stages).toEqual([
      { stage: 'images', outcome: 'ok', n: 1 },
      { stage: 'review', outcome: 'ok', n: 1 },
      { stage: 'script', outcome: 'ok', n: 1 },
      { stage: 'tts', outcome: 'ok', n: expect.any(Number) },
    ])
    const scenes = h.sqlite.prepare('SELECT n, start_ms, end_ms, image_query FROM scenes ORDER BY n').all() as Array<{ start_ms: number; end_ms: number; image_query: string }>
    expect(scenes.length).toBeGreaterThanOrEqual(6)
    for (let i = 1; i < scenes.length; i++) expect(scenes[i]!.start_ms).toBeGreaterThan(scenes[i - 1]!.end_ms)
    expect(scenes.every((x) => x.image_query.length > 0)).toBe(true)
    const timings = JSON.parse((h.sqlite.prepare('SELECT stage_timings FROM jobs').get() as { stage_timings: string }).stage_timings)
    expect(Object.keys(timings).sort()).toEqual(['assemble', 'images', 'review', 'script', 'tts'])
    h.close()
  }, 120_000)

  it('provedor fora do ar → fallback e o vídeo termina com o próximo (critério 5)', async () => {
    const log: FixtureLog = { calls: [] }
    const { c, channelId } = await setup(fixtureSource([downLlm('down-llm', log), fixtureLlm('fixture-llm', log)], [fixtureTts('fixture-tts', log)]))
    const g = await c.run('generate', '--theme', 'Por que o céu é azul', '--channel', channelId, '--duration', '60', '--wait', '--json')
    expect(g.code).toBe(EXIT.ok)
    expect(JSON.parse(g.out).state).toBe('done')
    const down = log.calls.filter((x) => x.provider === 'down-llm')
    expect(down.length).toBe(9) // 3 tentativas × (roteiro, revisão, cenas)
    expect(log.calls.filter((x) => x.provider === 'fixture-llm').length).toBe(3)
  }, 120_000)

  it('recusa de política → needs_input com a mensagem, sem trocar de provedor (critério 6)', async () => {
    const log: FixtureLog = { calls: [] }
    const { c, channelId } = await setup(fixtureSource([refusingLlm('refusing-llm', log), fixtureLlm('fixture-llm', log)], [fixtureTts()]))
    const g = await c.run('generate', '--theme', 'Tema recusado', '--channel', channelId, '--duration', '60', '--wait', '--json')
    expect(g.code).toBe(EXIT.error)
    const s = JSON.parse(g.out)
    expect(s.state).toBe('needs_input')
    expect(s.error.code).toBe('PROVIDER_REFUSAL')
    expect(s.error.message).toContain('política de uso')
    expect(log.calls.map((x) => x.provider)).toEqual(['refusing-llm'])
  }, 60_000)

  it('entrada inválida → código 2; comando desconhecido → 2', async () => {
    const { c, channelId } = await setup(fixtureSource([fixtureLlm()], [fixtureTts()]))
    expect((await c.run('generate', '--theme', 'x', '--channel', channelId)).code).toBe(EXIT.invalid)
    expect((await c.run('generate', '--theme', 'Tema bom', '--channel', 'nao-existe')).code).toBe(EXIT.invalid)
    expect((await c.run('generate', '--theme', 'Tema bom', '--channel', channelId, '--duration', '9999')).code).toBe(EXIT.invalid)
    expect((await c.run('generate', '--theme', 'Tema bom', '--channel', channelId, '--lang', 'fr')).code).toBe(EXIT.invalid)
    expect((await c.run('voar')).code).toBe(EXIT.invalid)
    expect((await c.run('status', 'nao-existe')).code).toBe(EXIT.invalid)
  })
})
