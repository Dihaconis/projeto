/**
 * Critério de aceite 3: matar o processo durante a montagem e reabrir retoma
 * do último segmento renderizado, sem refazer roteiro, narração nem imagens.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobQueue, createChannel, createVideoJob, setSetting } from '../../src/core'
import { makeEnv, waitFor, type TestEnv } from '../helpers/env'

const CHILD = path.resolve(__dirname, '../helpers/runner-child.ts')
const children: ChildProcess[] = []
let env: TestEnv | undefined

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  env?.cleanup()
  env = undefined
})

function startRunner(root: string, orphanMs: number): ChildProcess {
  const c = spawn(process.execPath, ['--import', 'tsx', CHILD, root, String(orphanMs), 'video'], {
    cwd: path.resolve(__dirname, '../..'),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(c)
  return c
}

describe('vídeo: kill -9 durante a montagem', () => {
  it('retoma do último segmento sem novas chamadas de roteiro/revisão/cenas/TTS', async () => {
    env = makeEnv()
    setSetting(env.handle, 'output.dir', path.join(env.paths.root, 'saída'))
    const ch = createChannel(env.handle, { name: 'Canal', niche: 'ciência', language: 'pt-BR' })
    const { video, job } = createVideoJob(env.handle, { channelId: ch.id, theme: 'Por que o céu é azul', durationS: 60 })
    const q = new JobQueue(env.handle)
    const segDir = path.join(env.paths.work, video.id, 'segments')

    const first = startRunner(env.paths.root, 1500)
    await waitFor(() => {
      const j = q.get(job.id)
      const cp = j?.checkpoint as { segments?: Record<string, true> } | undefined
      return j?.stage === 'assemble' && Object.keys(cp?.segments ?? {}).length >= 2 ? j : null
    }, 90_000, 5)
    first.kill('SIGKILL')
    await waitFor(() => first.exitCode !== null || first.signalCode !== null)
    expect(q.get(job.id)?.state).toBe('running')

    const callsBefore = env.handle.sqlite.prepare('SELECT COUNT(*) n FROM provider_log').get() as { n: number }
    const segsBefore = new Map(
      fs.readdirSync(segDir).filter((f) => f.endsWith('.mp4')).map((f) => [f, fs.statSync(path.join(segDir, f)).mtimeMs]),
    )
    const cpBefore = q.get(job.id)!.checkpoint as { segments: Record<string, true> }
    const narrationMtime = fs.statSync(path.join(env.paths.work, video.id, 'narration.wav')).mtimeMs

    const second = startRunner(env.paths.root, 1500)
    const done = await waitFor(() => (q.get(job.id)?.state === 'done' ? q.get(job.id) : null), 90_000)
    second.kill('SIGKILL')

    expect(done!.attempt).toBe(2)
    const callsAfter = env.handle.sqlite.prepare('SELECT COUNT(*) n FROM provider_log').get() as { n: number }
    expect(callsAfter.n).toBe(callsBefore.n) // nenhum roteiro, revisão, cena ou TTS refeito
    expect(fs.statSync(path.join(env.paths.work, video.id, 'narration.wav')).mtimeMs).toBe(narrationMtime)
    for (const n of Object.keys(cpBefore.segments)) {
      const f = `${n.padStart(3, '0')}.mp4`
      expect(fs.statSync(path.join(segDir, f)).mtimeMs).toBe(segsBefore.get(f)) // segmento pronto não foi refeito
    }
    const v = env.handle.sqlite.prepare('SELECT output_path FROM videos WHERE id = ?').get(video.id) as { output_path: string }
    expect(fs.existsSync(v.output_path)).toBe(true)
  }, 180_000)
})
