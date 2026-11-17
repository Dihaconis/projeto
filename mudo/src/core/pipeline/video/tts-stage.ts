import fs from 'node:fs'
import path from 'node:path'
import { DURATION, VIDEO_SPEC, durationWindowS } from '../../../shared/enums'
import { runFfmpeg } from '../../media/ffmpeg'
import { buildNarrationWav } from '../../media/wav'
import { writeFileAtomic } from '../../paths'
import { callWithFallback } from '../../providers/call'
import type { TtsProvider } from '../../providers/types'
import { JobError, NeedsInputError } from '../../queue/errors'
import { loadScenes, updateScene, updateVideo, type VideoJobState } from './state'

const pad = (n: number) => String(n).padStart(3, '0')
const TTS_PARALLEL = 4

/**
 * Normaliza um trecho: tira silêncio das pontas e aplica loudnorm, em PCM
 * 48 kHz mono. Em duas passadas: o ffmpeg 7.0 aborta (assert em
 * ffmpeg_filter.c) quando `areverse` e `loudnorm` estão na mesma cadeia.
 */
async function normalizeClip(st: VideoJobState, input: string, output: string): Promise<void> {
  fs.mkdirSync(st.ctx.tmpDir, { recursive: true })
  const trimmed = path.join(st.ctx.tmpDir, `${path.basename(output)}.trim.wav`)
  const tmp = path.join(st.ctx.tmpDir, `${path.basename(output)}.tmp.wav`)
  const pcm = ['-ac', '1', '-ar', String(VIDEO_SPEC.audioRate), '-c:a', 'pcm_s16le']
  const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05'
  await runFfmpeg(st.ctx.spawn, st.ctx.media, ['-i', input, '-af', `${trim},areverse,${trim},areverse`, ...pcm, trimmed], {
    what: 'cortar o silêncio do áudio da cena',
  })
  await runFfmpeg(st.ctx.spawn, st.ctx.media, ['-i', trimmed, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${VIDEO_SPEC.audioRate}`, ...pcm, tmp], {
    what: 'normalizar o áudio da cena',
  })
  fs.rmSync(trimmed, { force: true })
  fs.renameSync(tmp, output)
}

function orderProviders(st: VideoJobState, all: TtsProvider[]): TtsProvider[] {
  const pref = st.channel.ttsProvider
  if (!pref) return all
  return [...all.filter((p) => p.id === pref), ...all.filter((p) => p.id !== pref)]
}

function voiceFor(st: VideoJobState, p: TtsProvider): string {
  return st.channel.voiceId && (st.channel.ttsProvider ?? p.id) === p.id ? st.channel.voiceId : p.defaultVoice(st.language)
}

/**
 * 8.5 — narração por cena (retomada e retrabalho cena a cena). O provedor é
 * escolhido na primeira cena (com fallback) e fica travado para o vídeo todo,
 * para a voz não mudar no meio; depois disso uma pane vira erro retomável.
 */
export async function ttsStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('tts')
  const sceneRows = loadScenes(st)
  if (sceneRows.length === 0) throw new JobError('INTERNAL', 'nenhuma cena para narrar')
  fs.mkdirSync(path.join(st.files.ttsDir, 'raw'), { recursive: true })

  const done = () => loadScenes(st).filter((s) => s.audioPath && fs.existsSync(path.join(ctx.workDir, s.audioPath))).length
  const allProviders = orderProviders(st, await ctx.providers.tts())
  let locked: TtsProvider | undefined
  if (st.cp.tts) {
    locked = allProviders.find((p) => p.id === st.cp.tts?.provider)
    if (!locked) {
      throw new NeedsInputError(
        'MISSING_KEY',
        `Este vídeo começou a ser narrado com ${st.cp.tts.provider}, que não está mais configurado. Restaure a chave para manter a mesma voz e retome.`,
      )
    }
  }

  const synth = async (scene: (typeof sceneRows)[number]) => {
    const providers = locked ? [locked] : allProviders
    const r = await callWithFallback(providers, (p) => ({ text: scene.text, voiceId: voiceFor(st, p), language: st.language }), {
      db: ctx.db,
      log: ctx.log,
      signal: ctx.signal,
      stage: 'tts',
      videoId: st.video.id,
    })
    ctx.addCost(r.output.costCents)
    if (!locked) {
      locked = providers.find((p) => p.id === r.providerId)!
      st.cp.tts = { provider: locked.id, voiceId: voiceFor(st, locked) }
      st.save()
      ctx.log.info({ provider: locked.id }, 'provedor de narração definido para o vídeo')
    }
    const raw = path.join(st.files.ttsDir, 'raw', `${pad(scene.n)}.${r.output.ext}`)
    writeFileAtomic(raw, r.output.audio)
    if (r.output.alignment) writeFileAtomic(path.join(st.files.ttsDir, 'raw', `${pad(scene.n)}.align.json`), JSON.stringify(r.output.alignment))
    const wavRel = path.join('tts', `${pad(scene.n)}.wav`)
    await normalizeClip(st, raw, path.join(ctx.workDir, wavRel))
    updateScene(st, scene.id, { audioPath: wavRel })
    ctx.stageProgress((done() / sceneRows.length) * 0.9)
  }

  const pending = sceneRows.filter((s) => !(s.audioPath && fs.existsSync(path.join(ctx.workDir, s.audioPath))))
  if (pending.length > 0 && !locked) await synth(pending.shift()!)
  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const s = pending[next++]!
      await synth(s)
    }
  }
  await Promise.all(Array.from({ length: Math.min(TTS_PARALLEL, pending.length) }, worker))

  await assembleNarration(st)
  ctx.stageProgress(1)
}

/** Junta as cenas com 250 ms entre cenas e 600 ms entre atos; ajusta velocidade se preciso. */
async function assembleNarration(st: VideoJobState): Promise<void> {
  const { ctx } = st
  const rows = loadScenes(st)
  if (st.cp.narration && fs.existsSync(st.files.narration) && rows.every((r) => r.startMs !== null && r.endMs !== null)) return

  const parts = rows.map((s, i) => {
    const nextScene = rows[i + 1]
    const pause = !nextScene ? 0 : nextScene.actId !== s.actId ? VIDEO_SPEC.actPauseMs : VIDEO_SPEC.scenePauseMs
    return { wavPath: path.join(ctx.workDir, s.audioPath!), pauseAfterMs: pause }
  })
  const rawFile = path.join(ctx.tmpDir, 'narration.raw.wav')
  fs.mkdirSync(ctx.tmpDir, { recursive: true })
  const tl = buildNarrationWav(parts, rawFile)

  const totalS = tl.totalMs / 1000
  const win = durationWindowS(st.video.targetDurationS)
  let tempo = 1
  if (totalS > win.max) tempo = totalS / win.max
  else if (totalS < win.min) tempo = totalS / win.min
  if (Math.abs(tempo - 1) > DURATION.maxTempoAdjust + 1e-9) {
    throw new NeedsInputError(
      'DURATION_OUT_OF_RANGE',
      `A narração ficou com ${totalS.toFixed(0)} s; a faixa aceita é ${win.min.toFixed(0)}–${win.max.toFixed(0)} s e o ajuste de velocidade máximo (±8%) não basta. Encurte ou alongue o roteiro e retome.`,
      { totalS, min: win.min, max: win.max },
    )
  }
  if (tempo !== 1) {
    // pequena folga para cair dentro da faixa mesmo com arredondamento do atempo
    tempo = tempo > 1 ? tempo * 1.002 : tempo * 0.998
    const out = path.join(ctx.tmpDir, 'narration.tempo.wav')
    await runFfmpeg(ctx.spawn, ctx.media, ['-i', rawFile, '-af', `atempo=${tempo.toFixed(5)}`, '-ac', '1', '-ar', String(VIDEO_SPEC.audioRate), '-c:a', 'pcm_s16le', out], {
      what: 'ajustar a velocidade da narração',
    })
    fs.renameSync(out, st.files.narration)
    fs.rmSync(rawFile, { force: true })
    ctx.log.info({ tempo, before: totalS }, 'velocidade da narração ajustada')
  } else {
    fs.renameSync(rawFile, st.files.narration)
  }
  const scale = 1 / tempo
  const db = ctx.db
  db.sqlite.transaction(() => {
    rows.forEach((s, i) => {
      const t = tl.parts[i]!
      updateScene(st, s.id, { startMs: Math.round(t.startMs * scale), endMs: Math.round(t.endMs * scale) })
    })
  })()
  const totalMs = Math.round(tl.totalMs * scale)
  updateVideo(st, { actualDurationS: totalMs / 1000 })
  st.cp.narration = { totalMs, tempo }
  st.save()
}
