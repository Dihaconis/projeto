import { eq, inArray } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AI_DISCLOSURE_METADATA, MUSIC_MOODS, VIDEO_SPEC, type Language } from '../../../shared/enums'
import { audioAssets, credits, images, scenes } from '../../db/schema'
import { preparedFrame } from '../../images/library'
import type { WordTime } from '../../media/align'
import { imageStrength, renderCreditPages, renderThumbnails } from '../../media/cards'
import { concatListLine, runFfmpeg } from '../../media/ffmpeg'
import { MOTION_INTENSITY, MOTIONS, pickMotions, zoompanFilter, type Motion } from '../../media/motion'
import { mixAndNormalize, pickMusic } from '../../media/music'
import { buildAss, DEFAULT_SUB_STYLE } from '../../media/subtitles'
import { writeFileAtomic } from '../../paths'
import { JobError } from '../../queue/errors'
import { getSetting } from '../../settings'
import { loadScenes, preset, readScript, updateVideo, type VideoJobState } from './state'

const pad = (n: number) => String(n).padStart(3, '0')
const FPS = VIDEO_SPEC.fps
/** Crossfade só na virada de ato (seção 8.6). */
const XFADE_S = 0.4
const XFADE_FRAMES = Math.round(XFADE_S * FPS)
/** Duração de cada página da cartela de créditos. */
const CREDIT_PAGE_S = 3.5

export const OUTPUT_DIR_SETTING = 'output.dir'

export function defaultOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir()
  return path.join(home, 'Videos', 'MUDO')
}

/**
 * Quadros de cada cena. A cena começa quando sua fala começa (a pausa antes
 * dela pertence à cena anterior) e a última vai até o fim do áudio. Fronteiras
 * arredondadas no acumulado, para não haver deriva de sincronia.
 */
export function sceneFrames(starts: number[], totalMs: number, fps = VIDEO_SPEC.fps): number[] {
  const bounds = starts.map((s, i) => (i === 0 ? 0 : Math.round((s * fps) / 1000)))
  bounds.push(Math.round((totalMs * fps) / 1000))
  return bounds.slice(0, -1).map((b, i) => Math.max(1, bounds[i + 1]! - b))
}

/** Seção 9: imagem sem licença ou que exige crédito sem texto de crédito não entra. */
export function assertLicenses(st: VideoJobState): void {
  const ids = [...new Set(loadScenes(st).map((s) => s.imageId).filter((x): x is string => !!x))]
  if (ids.length === 0) throw new JobError('LICENSE_MISSING', 'Nenhuma imagem com licença registrada para as cenas.')
  const rows = st.ctx.db.db.select().from(images).where(inArray(images.id, ids)).all()
  const bad = rows.filter((r) => !r.license || (r.requiresCredit && !r.creditText?.trim()))
  if (bad.length > 0 || rows.length !== ids.length) {
    throw new JobError(
      'LICENSE_MISSING',
      `${bad.length || ids.length - rows.length} imagem(ns) sem licença ou sem o crédito exigido. Corrija na tela de Licenças e retome.`,
      false,
      { images: bad.map((b) => ({ id: b.id, source: b.source, sourceUrl: b.sourceUrl })) },
    )
  }
}

/** Palavras do vídeo inteiro, em ms na linha do tempo final (com o ajuste de velocidade). */
export function globalWords(st: VideoJobState): WordTime[][] {
  const tempo = st.cp.narration?.tempo ?? 1
  return loadScenes(st).map((s) => {
    const f = path.join(st.files.ttsDir, `${pad(s.n)}.words.json`)
    if (!fs.existsSync(f) || s.startMs === null) return []
    const local = JSON.parse(fs.readFileSync(f, 'utf8')) as WordTime[]
    return local.map((w) => ({ word: w.word, startMs: s.startMs! + w.startMs / tempo, endMs: s.startMs! + w.endMs / tempo }))
  })
}

const LABELS: Record<Language, { tags: string; credits: string; narration: string; ownImages: string; ai: string; music: string }> = {
  'pt-BR': {
    tags: 'Tags',
    credits: 'Créditos',
    narration: 'Narração: voz sintética',
    ownImages: 'Imagens: acervo próprio ou de licença livre (sem crédito exigido)',
    music: 'Trilha: MUDO (licença própria)',
    ai: 'Este vídeo contém conteúdo gerado ou alterado por IA (roteiro, narração e montagem).',
  },
  es: {
    tags: 'Etiquetas',
    credits: 'Créditos',
    narration: 'Narración: voz sintética',
    ownImages: 'Imágenes: acervo propio o de licencia libre (sin crédito exigido)',
    music: 'Música: MUDO (licencia propia)',
    ai: 'Este video contiene contenido generado o alterado por IA (guion, narración y montaje).',
  },
  en: {
    tags: 'Tags',
    credits: 'Credits',
    narration: 'Narration: synthetic voice',
    ownImages: 'Images: own library or free license (no credit required)',
    music: 'Music: MUDO (own license)',
    ai: 'This video contains AI-generated or AI-altered content (script, narration and editing).',
  },
}

/** Linhas de crédito do vídeo (imagens e música com crédito), na ordem gravada. */
function creditLines(st: VideoJobState): string[] {
  return st.ctx.db.db
    .select()
    .from(credits)
    .where(eq(credits.videoId, st.video.id))
    .all()
    .sort((a, b) => a.position - b.position)
    .map((c) => c.text)
}

/**
 * 8.6 — montagem completa: cada cena vira um segmento (movimento + legenda,
 * crossfade na virada de ato) com checkpoint; cartela de créditos; trilha com
 * ducking e loudnorm em duas passadas; thumbnails; .txt.
 */
export async function assembleStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('assemble')
  if (st.cp.output && fs.existsSync(st.cp.output.mp4)) {
    ctx.stageProgress(1)
    return
  }
  assertLicenses(st)
  const release = await ctx.acquire('assemble')
  try {
    const rows = loadScenes(st)
    const totalMs = st.cp.narration?.totalMs
    if (!totalMs || rows.some((r) => r.startMs === null)) throw new JobError('INTERNAL', 'narração sem linha do tempo')
    const p = preset(st)
    const L = LABELS[st.language]
    const frames = sceneFrames(rows.map((r) => r.startMs!), totalMs)
    const segStartMs = frames.map((_, i) => (frames.slice(0, i).reduce((a, b) => a + b, 0) * 1000) / FPS)
    fs.mkdirSync(st.files.segmentsDir, { recursive: true })
    fs.mkdirSync(ctx.tmpDir, { recursive: true })
    // fontes embarcadas ao lado dos .ass: o ffmpeg roda com cwd=tmp e caminhos relativos
    // (evita escapar ":" e "\" de caminhos do Windows dentro do filtro)
    const fontsLocal = path.join(ctx.tmpDir, 'fonts')
    fs.mkdirSync(fontsLocal, { recursive: true })
    for (const f of fs.readdirSync(ctx.media.fontsDir)) if (f.endsWith('.ttf')) fs.copyFileSync(path.join(ctx.media.fontsDir, f), path.join(fontsLocal, f))

    // movimentos alternados, persistidos por cena (retomada mantém a mesma sequência)
    let motions = rows.map((r) => (MOTIONS as readonly string[]).includes(r.motion ?? '') ? (r.motion as Motion) : null)
    if (motions.some((m) => m === null)) {
      const seq = pickMotions(rows.length, st.video.id)
      motions = seq
      ctx.db.sqlite.transaction(() => rows.forEach((r, i) => ctx.db.db.update(scenes).set({ motion: seq[i]! }).where(eq(scenes.id, r.id)).run()))()
    }
    const intensity = MOTION_INTENSITY[p.motionIntensity]

    // quadros 4K 16:9 com recorte inteligente, cacheados por imagem
    const framePath = new Map<string, string>()
    for (const img of ctx.db.db.select({ id: images.id, path: images.path }).from(images).where(inArray(images.id, [...new Set(rows.map((r) => r.imageId!))])).all()) {
      if (!fs.existsSync(img.path)) throw new JobError('INTERNAL', `arquivo de imagem sumiu: ${img.path}`)
      framePath.set(img.id, await preparedFrame(ctx.paths, img))
    }

    const words = globalWords(st)
    const style = { ...DEFAULT_SUB_STYLE, highlight: p.highlightColor, color: p.subtitleColor }

    // ---- cartela final de créditos ----
    const credLines = [L.narration, ...creditLines(st)]
    const pages = await renderCreditPages({ fontsDir: ctx.media.fontsDir, heading: L.credits, lines: credLines, footer: L.ai, dir: path.join(ctx.tmpDir, 'credits') })
    const creditFrames = Math.round(CREDIT_PAGE_S * FPS)
    const totalVideoS = totalMs / 1000 + (pages.length * creditFrames) / FPS

    // ---- segmentos (60% do progresso), em paralelo, cada um com checkpoint ----
    const totalFrames = frames.reduce((a, b) => a + b, 0) + pages.length * creditFrames
    const partial = new Map<string, number>()
    let framesDone = 0
    const report = () => {
      let inFlight = 0
      for (const v of partial.values()) inFlight += v
      ctx.stageProgress(((framesDone + inFlight) / totalFrames) * 0.6)
    }
    type Job = { key: string; file: string; frames: number; args: string[]; what: string }
    const jobs: Job[] = []
    rows.forEach((scene, i) => {
      const n = frames[i]!
      const key = String(scene.n)
      const file = path.join(st.files.segmentsDir, `${pad(scene.n)}.mp4`)
      const assName = `sub-${pad(scene.n)}.ass`
      const from = segStartMs[i]!
      const to = from + (n * 1000) / FPS
      const zp = zoompanFilter(motions[i]!, n, intensity, FPS)
      const actStart = i > 0 && rows[i - 1]!.actId !== scene.actId && n > XFADE_FRAMES
      const inputs = ['-i', framePath.get(scene.imageId!)!]
      let graph: string
      if (actStart) {
        // a cena anterior continua seu movimento por 0,4 s e funde nesta: a linha do tempo não muda
        const prevN = frames[i - 1]!
        const prevZp = zoompanFilter(motions[i - 1]!, XFADE_FRAMES, intensity, FPS, { fromFrame: prevN, span: prevN })
        inputs.push('-i', framePath.get(rows[i - 1]!.imageId!)!)
        graph =
          `[1:v]${prevZp},format=yuv420p,settb=AVTB,setsar=1[a];[0:v]${zp},format=yuv420p,settb=AVTB,setsar=1[b];` +
          `[a][b]xfade=transition=fade:duration=${XFADE_S}:offset=0,subtitles=${assName}:fontsdir=fonts,format=yuv420p[v]`
      } else {
        graph = `[0:v]${zp},setsar=1,subtitles=${assName}:fontsdir=fonts,format=yuv420p[v]`
      }
      jobs.push({
        key,
        file,
        frames: n,
        what: `renderizar a cena ${scene.n}`,
        args: [
          ...inputs,
          '-filter_complex', graph, '-map', '[v]',
          '-frames:v', String(n), '-r', String(FPS),
          '-c:v', 'libx264', '-preset', VIDEO_SPEC.preset, '-crf', String(VIDEO_SPEC.crf), '-pix_fmt', 'yuv420p',
          '-an', `seg-${pad(scene.n)}.mp4`,
        ],
      })
      // a legenda de cada segmento cobre só a fala daquela cena, em tempo local
      fs.writeFileSync(path.join(ctx.tmpDir, assName), buildAss(words[i] ?? [], from, to, style))
    })
    pages.forEach((page, k) => {
      const fadeOutStart = CREDIT_PAGE_S - 0.4
      jobs.push({
        key: `credits-${k + 1}`,
        file: path.join(st.files.segmentsDir, `credits-${k + 1}.mp4`),
        frames: creditFrames,
        what: 'renderizar a cartela de créditos',
        args: [
          '-i', page,
          '-vf', `zoompan=z=1:d=${creditFrames}:s=${VIDEO_SPEC.width}x${VIDEO_SPEC.height}:fps=${FPS},setsar=1,fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutStart}:d=0.4,format=yuv420p`,
          '-frames:v', String(creditFrames), '-r', String(FPS),
          '-c:v', 'libx264', '-preset', VIDEO_SPEC.preset, '-crf', String(VIDEO_SPEC.crf), '-pix_fmt', 'yuv420p',
          '-an', `seg-credits-${k + 1}.mp4`,
        ],
      })
    })

    const todo = jobs.filter((j) => {
      if (st.cp.segments[j.key] && fs.existsSync(j.file)) {
        framesDone += j.frames
        return false
      }
      return true
    })
    report()
    const renderOne = async (j: Job) => {
      const tmpName = j.args.at(-1)!
      await runFfmpeg(ctx.spawn, ctx.media, j.args, {
        what: j.what,
        expectedS: j.frames / FPS,
        cwd: ctx.tmpDir,
        onProgress: (f) => {
          partial.set(j.key, f * j.frames)
          report()
        },
      })
      fs.renameSync(path.join(ctx.tmpDir, tmpName), j.file)
      partial.delete(j.key)
      st.cp.segments[j.key] = true
      st.save()
      framesDone += j.frames
      report()
    }
    const parallel = getSetting(ctx.db, 'assemble.parallelSegments', z.number().int().min(1).max(8), 3)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(parallel, todo.length) }, async () => {
        while (next < todo.length) await renderOne(todo[next++]!)
      }),
    )

    // ---- trilha + loudnorm (20%) ----
    const audioFile = path.join(ctx.workDir, 'audio.wav')
    if (!st.cp.audio || !fs.existsSync(audioFile)) {
      const mood = z.enum(MUSIC_MOODS).catch('calm').parse(st.channel.musicMood ?? 'calm')
      const music = await pickMusic(ctx.db, ctx.spawn, ctx.media, path.join(ctx.paths.root, 'music'), mood, rows.length)
      if (music.requiresCredit && music.creditText) {
        const pos = creditLines(st).length
        ctx.db.db.insert(credits).values({ videoId: st.video.id, text: music.creditText, position: pos }).onConflictDoNothing().run()
      }
      const tmpAudio = path.join(ctx.tmpDir, 'audio.wav')
      await mixAndNormalize(ctx.spawn, ctx.media, {
        narration: st.files.narration,
        music: music.path,
        totalS: totalVideoS,
        out: tmpAudio,
        tmpDir: ctx.tmpDir,
        onProgress: (f) => ctx.stageProgress(0.6 + f * 0.2),
      })
      fs.renameSync(tmpAudio, audioFile)
      st.cp.audio = { musicId: music.id }
      st.save()
    }

    // ---- concat (cópia) + áudio AAC + metadado de IA (15%) ----
    const list = path.join(ctx.tmpDir, 'segments.txt')
    fs.writeFileSync(list, jobs.map((j) => concatListLine(j.file)).join('\n'))
    const script = readScript(st)
    const tmpOut = path.join(ctx.tmpDir, 'final.mp4')
    await runFfmpeg(
      ctx.spawn,
      ctx.media,
      [
        '-f', 'concat', '-safe', '0', '-i', list,
        '-i', audioFile,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', VIDEO_SPEC.audioBitrate, '-ar', String(VIDEO_SPEC.audioRate), '-ac', '2',
        '-shortest',
        '-movflags', '+faststart',
        '-metadata', `title=${script.title}`,
        '-metadata', `comment=${AI_DISCLOSURE_METADATA}`,
        tmpOut,
      ],
      { what: 'montar o vídeo final', expectedS: totalVideoS, onProgress: (f) => ctx.stageProgress(0.8 + f * 0.15) },
    )
    await finalize(st, tmpOut, credLines, totalVideoS)
  } finally {
    release()
  }
  ctx.stageProgress(1)
}

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 60)
      .trim() || 'video'
  )
}

/** Imagens do ato 1 da mais "forte" para a mais fraca (base da thumbnail). */
async function thumbnailImages(st: VideoJobState): Promise<string[]> {
  const rows = loadScenes(st)
  const firstAct = rows[0]?.actId
  const ids = [...new Set(rows.filter((r) => r.actId === firstAct).map((r) => r.imageId!))]
  const imgs = st.ctx.db.db.select({ id: images.id, path: images.path }).from(images).where(inArray(images.id, ids)).all()
  const scored = await Promise.all(imgs.map(async (i) => ({ path: i.path, s: await imageStrength(i.path) })))
  return scored.sort((a, b) => b.s - a.s).map((x) => x.path)
}

/** 8.7 — move o MP4 para a pasta de saída; grava thumbnails e o .txt com título, descrição e créditos. */
async function finalize(st: VideoJobState, tmpMp4: string, credLines: string[], totalS: number): Promise<void> {
  const { ctx } = st
  const outDir = getSetting(ctx.db, OUTPUT_DIR_SETTING, z.string().min(1), defaultOutputDir())
  fs.mkdirSync(outDir, { recursive: true })
  const script = readScript(st)
  const date = new Date().toISOString().slice(0, 10)
  let base = `${date} - ${slug(script.title)}`
  for (let i = 2; fs.existsSync(path.join(outDir, `${base}.mp4`)); i++) base = `${date} - ${slug(script.title)} (${i})`
  const mp4 = path.join(outDir, `${base}.mp4`)
  const txt = path.join(outDir, `${base}.txt`)
  const thumbs: [string, string] = [path.join(outDir, `${base} - thumbnail 1.jpg`), path.join(outDir, `${base} - thumbnail 2.jpg`)]

  await renderThumbnails({ fontsDir: ctx.media.fontsDir, images: await thumbnailImages(st), title: script.thumbnail_title, highlight: preset(st).highlightColor, out: thumbs })

  const L = LABELS[st.language]
  const music = st.cp.audio ? ctx.db.db.select().from(audioAssets).where(eq(audioAssets.id, st.cp.audio.musicId)).get() : undefined
  const imageCredits = credLines.slice(1)
  const text = [
    script.title,
    '',
    script.description,
    '',
    `${L.tags}: ${script.tags.join(', ')}`,
    '',
    `${L.credits}:`,
    ...credLines.slice(0, 1).map((c) => `- ${c}`),
    ...(imageCredits.length > 0 ? imageCredits.map((c) => `- ${c}`) : [`- ${L.ownImages}`]),
    ...(music && !music.requiresCredit ? [`- ${L.music}`] : []),
    '',
    L.ai,
    '',
  ].join('\n')

  fs.copyFileSync(tmpMp4, mp4)
  fs.rmSync(tmpMp4, { force: true })
  writeFileAtomic(txt, text)
  st.cp.output = { mp4, txt }
  st.save()
  updateVideo(st, {
    outputPath: mp4,
    thumbPath: thumbs[0],
    // duração do arquivo (narração + cartela): o mesmo número em toda tela
    actualDurationS: Math.round(totalS * 1000) / 1000,
    title: script.title,
    description: script.description,
    genTimeS: Math.round(ctx.elapsedMs() / 100) / 10,
  })
}
