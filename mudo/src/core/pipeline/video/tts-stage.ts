import fs from 'node:fs'
import path from 'node:path'
import { DURATION, VIDEO_SPEC, durationWindowS } from '../../../shared/enums'
import { whisperAlign, wordsFromCharAlignment, type WordTime } from '../../media/align'
import { probeDurationS, runFfmpeg } from '../../media/ffmpeg'
import type { CharAlignment } from '../../providers/types'
import { buildNarrationWav } from '../../media/wav'
import { writeFileAtomic } from '../../paths'
import { callWithFallback } from '../../providers/call'
import type { TtsProvider } from '../../providers/types'
import { JobError, NeedsInputError } from '../../queue/errors'
import { loadScenes, updateScene, updateVideo, type VideoJobState } from './state'

const pad = (n: number) => String(n).padStart(3, '0')
const TTS_PARALLEL = 4

/** Silêncio nas pontas, em segundos, lido do `silencedetect`. */
export function parseSilences(lines: string[], durationS: number): { leadS: number; tailS: number } {
  const events: Array<{ start: number; end: number | null }> = []
  for (const l of lines) {
    const s = /silence_start: (-?[\d.]+)/.exec(l)
    if (s) events.push({ start: Number(s[1]), end: null })
    const e = /silence_end: ([\d.]+)/.exec(l)
    if (e && events.length > 0) events[events.length - 1]!.end = Number(e[1])
  }
  const first = events[0]
  const leadS = first && first.start <= 0.01 && first.end !== null ? first.end : 0
  const last = events.at(-1)
  const tailS = last && (last.end === null || last.end >= durationS - 0.01) && last.start > leadS ? durationS - last.start : 0
  return { leadS, tailS }
}

/**
 * Normaliza um trecho: corta o silêncio das pontas (guardando quanto saiu do
 * início, para ajustar os timestamps do provedor) e aplica loudnorm, em PCM
 * 48 kHz mono.
 */
async function normalizeClip(st: VideoJobState, input: string, output: string): Promise<{ trimStartMs: number }> {
  const { ctx } = st
  fs.mkdirSync(ctx.tmpDir, { recursive: true })
  const lines: string[] = []
  const det = await ctx.spawn(ctx.media.ffmpeg, ['-hide_banner', '-nostdin', '-i', input, '-af', 'silencedetect=n=-50dB:d=0.05', '-f', 'null', '-'], {
    onStderrLine: (l) => lines.push(l),
  })
  if (det.code !== 0) throw new JobError('FFMPEG_FAILED', 'ffmpeg falhou ao analisar o áudio da cena.', false, { stderr: det.stderrTail })
  const durationS = await probeDurationS(ctx.spawn, ctx.media, input)
  const { leadS, tailS } = parseSilences(lines, durationS)
  const start = Math.max(0, leadS - 0.04)
  const end = Math.max(start + 0.1, durationS - Math.max(0, tailS - 0.04))
  const tmp = path.join(ctx.tmpDir, `${path.basename(output)}.tmp.wav`)
  await runFfmpeg(
    ctx.spawn,
    ctx.media,
    [
      '-i', input,
      '-af', `atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)},asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${VIDEO_SPEC.audioRate}`,
      '-ac', '1', '-ar', String(VIDEO_SPEC.audioRate), '-c:a', 'pcm_s16le', tmp,
    ],
    { what: 'normalizar o áudio da cena' },
  )
  fs.renameSync(tmp, output)
  return { trimStartMs: start * 1000 }
}

/**
 * Tempo de cada palavra no trecho já cortado: timestamps do provedor quando
 * existem; senão whisper.cpp sobre o texto conhecido (seção 8.5).
 */
async function sceneWords(st: VideoJobState, n: number, text: string, wav: string, trimStartMs: number): Promise<WordTime[]> {
  const alignFile = path.join(st.files.ttsDir, 'raw', `${pad(n)}.align.json`)
  const durMs = (await probeDurationS(st.ctx.spawn, st.ctx.media, wav)) * 1000
  if (fs.existsSync(alignFile)) {
    const al = JSON.parse(fs.readFileSync(alignFile, 'utf8')) as CharAlignment
    return wordsFromCharAlignment(text, al, trimStartMs).map((w) => ({ ...w, endMs: Math.min(w.endMs, durMs) }))
  }
  return whisperAlign(st.ctx.spawn, st.ctx.media, wav, text, st.language, st.ctx.tmpDir, durMs)
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
    const { trimStartMs } = await normalizeClip(st, raw, path.join(ctx.workDir, wavRel))
    writeFileAtomic(path.join(st.files.ttsDir, `${pad(scene.n)}.trim.json`), JSON.stringify({ trimStartMs }))
    const words = await sceneWords(st, scene.n, scene.text, path.join(ctx.workDir, wavRel), trimStartMs)
    writeFileAtomic(wordsFile(scene.n), JSON.stringify(words))
    updateScene(st, scene.id, { audioPath: wavRel })
    ctx.stageProgress((done() / sceneRows.length) * 0.9)
  }
  const wordsFile = (n: number) => path.join(st.files.ttsDir, `${pad(n)}.words.json`)

  // cena com áudio pronto mas sem tempos de palavra (retomada antiga): calcula só o alinhamento
  for (const s of sceneRows) {
    if (s.audioPath && fs.existsSync(path.join(ctx.workDir, s.audioPath)) && !fs.existsSync(wordsFile(s.n))) {
      const trimFile = path.join(st.files.ttsDir, `${pad(s.n)}.trim.json`)
      const trimStartMs = fs.existsSync(trimFile) ? (JSON.parse(fs.readFileSync(trimFile, 'utf8')) as { trimStartMs: number }).trimStartMs : 0
      const words = await sceneWords(st, s.n, s.text, path.join(ctx.workDir, s.audioPath), trimStartMs)
      writeFileAtomic(wordsFile(s.n), JSON.stringify(words))
    }
  }

  const pending = sceneRows.filter((s) => !(s.audioPath && fs.existsSync(path.join(ctx.workDir, s.audioPath)) && fs.existsSync(wordsFile(s.n))))
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
