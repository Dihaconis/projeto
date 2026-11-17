/**
 * Handler de teste (só existe em /tests). Era o job de teste da Fase 1; saiu do
 * produto na Fase 2 e ficou aqui para exercitar a fila sem provedores. Não gera vídeo: percorre as etapas reais do pipeline, grava um
 * artefato por passo em `work/<id>/`, registra checkpoint por passo e, na
 * montagem, executa um processo filho real (mesmo caminho que o ffmpeg usará)
 * com progresso lido do stderr. Serve para provar fila, retomada, cancelamento
 * e recuperação de órfãos.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { STAGES, type Stage } from '../../src/shared/enums'
import { writeFileAtomic } from '../../src/core/paths'
import { JobError } from '../../src/core/queue/errors'
import type { JobContext, JobHandler, JobHandlers } from '../../src/core/pipeline/context'

export const selftestPayloadSchema = z.object({
  /** Duração de cada passo em ms. */
  stepMs: z.number().int().min(10).max(10_000).default(400),
})
export type SelftestPayload = z.infer<typeof selftestPayloadSchema>

/** Passos por etapa: imagens/narração/montagem simulam 4 cenas. */
export const SELFTEST_STEPS: Record<Stage, number> = {
  script: 1,
  review: 1,
  images: 4,
  tts: 4,
  assemble: 4,
}

const checkpointSchema = z.object({ steps: z.record(z.string(), z.literal(true)).default({}) })

/** Script do processo filho: imita o ffmpeg emitindo `time=` no stderr. */
const CHILD_SCRIPT = `
const fs = require('fs');
const [out, ms] = [process.argv[1], Number(process.argv[2])];
const ticks = 5; let i = 0;
const t = setInterval(() => {
  i++;
  const s = ((ms / 1000) * i / ticks).toFixed(2);
  process.stderr.write('frame=' + i + ' time=00:00:' + s.padStart(5, '0') + ' speed=1x\\r');
  if (i >= ticks) { clearInterval(t); fs.writeFileSync(out, 'segment ' + Date.now()); process.exit(0); }
}, Math.max(1, Math.floor(ms / ticks)));
`

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const selftestHandler: JobHandler = async (ctx: JobContext) => {
  const payload = selftestPayloadSchema.parse(ctx.job.payload)
  const cp = checkpointSchema.parse(ctx.checkpoint<unknown>() ?? {})
  const execLog = path.join(ctx.workDir, 'exec.log')

  for (const stage of STAGES) {
    ctx.enterStage(stage)
    const total = SELFTEST_STEPS[stage]
    let release: (() => void) | null = null
    try {
      for (let n = 1; n <= total; n++) {
        const key = `${stage}:${n}`
        const artifact = path.join(ctx.workDir, stage, `${n}.json`)
        if (cp.steps[key] && fs.existsSync(artifact)) {
          ctx.stageProgress(n / total)
          continue
        }
        if (stage === 'assemble' && !release) release = await ctx.acquire('assemble')
        fs.appendFileSync(execLog, `${key}\n`)

        if (stage === 'assemble') {
          const segTmp = path.join(ctx.tmpDir, `segment-${n}.bin`)
          fs.mkdirSync(ctx.tmpDir, { recursive: true })
          const durationS = payload.stepMs / 1000
          const r = await ctx.spawn(process.execPath, ['-e', CHILD_SCRIPT, segTmp, String(payload.stepMs)], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            onStderrLine: (line) => {
              const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
              if (!m) return
              const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
              ctx.stageProgress((n - 1 + Math.min(1, sec / durationS)) / total)
            },
          })
          if (r.code !== 0 || !fs.existsSync(segTmp)) {
            throw new JobError('INTERNAL', `processo de segmento ${n} saiu com código ${r.code}`, true, {
              stderr: r.stderrTail,
            })
          }
          writeFileAtomic(artifact, JSON.stringify({ stage, n, segment: fs.readFileSync(segTmp, 'utf8') }))
          fs.rmSync(segTmp, { force: true })
        } else {
          await sleep(payload.stepMs, ctx.signal)
          writeFileAtomic(artifact, JSON.stringify({ stage, n, at: Date.now() }))
        }

        cp.steps[key] = true
        ctx.saveCheckpoint(cp)
        ctx.stageProgress(n / total)
      }
    } finally {
      release?.()
    }
  }
}

export const testHandlers: JobHandlers = { video: selftestHandler }
