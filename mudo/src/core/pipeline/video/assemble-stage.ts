import { eq, inArray } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AI_DISCLOSURE_METADATA, VIDEO_SPEC, type Language } from '../../../shared/enums'
import { credits, images } from '../../db/schema'
import { preparedFrame } from '../../images/library'
import { concatListLine, runFfmpeg } from '../../media/ffmpeg'
import { writeFileAtomic } from '../../paths'
import { JobError } from '../../queue/errors'
import { getSetting } from '../../settings'
import { loadScenes, readScript, updateVideo, type VideoJobState } from './state'

const pad = (n: number) => String(n).padStart(3, '0')

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

/** 8.6 — cada cena vira um segmento (checkpoint); no fim, concatena e mistura o áudio. */
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
    const frames = sceneFrames(rows.map((r) => r.startMs!), totalMs)
    const totalFrames = frames.reduce((a, b) => a + b, 0)
    fs.mkdirSync(st.files.segmentsDir, { recursive: true })
    fs.mkdirSync(ctx.tmpDir, { recursive: true })
    // quadro 4K 16:9 com recorte inteligente, cacheado por imagem
    const imagePaths = new Map<string, string>()
    for (const img of ctx.db.db
      .select({ id: images.id, path: images.path })
      .from(images)
      .where(inArray(images.id, [...new Set(rows.map((r) => r.imageId!))]))
      .all()) {
      if (!fs.existsSync(img.path)) throw new JobError('INTERNAL', `arquivo de imagem sumiu: ${img.path}`)
      imagePaths.set(img.id, await preparedFrame(ctx.paths, img))
    }

    // 70% do progresso nos segmentos, 30% no final. O zoompan é monothread,
    // então alguns segmentos rodam em paralelo (cada um com checkpoint próprio).
    const partial = new Map<number, number>()
    let framesDone = 0
    const report = () => {
      let inFlight = 0
      for (const v of partial.values()) inFlight += v
      ctx.stageProgress(((framesDone + inFlight) / totalFrames) * 0.7)
    }
    const todo: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const scene = rows[i]!
      if (st.cp.segments[String(scene.n)] && fs.existsSync(path.join(st.files.segmentsDir, `${pad(scene.n)}.mp4`))) framesDone += frames[i]!
      else todo.push(i)
    }
    report()
    const renderOne = async (i: number) => {
      const scene = rows[i]!
      const n = frames[i]!
      const seg = path.join(st.files.segmentsDir, `${pad(scene.n)}.mp4`)
      const img = imagePaths.get(scene.imageId!)
      if (!img || !fs.existsSync(img)) throw new JobError('INTERNAL', `imagem da cena ${scene.n} não encontrada`)
      const tmp = path.join(ctx.tmpDir, `seg-${pad(scene.n)}.mp4`)
      await runFfmpeg(
        ctx.spawn,
        ctx.media,
        [
          // a imagem 4K é decodificada uma vez; o zoompan gera os N quadros
          '-i', img,
          '-frames:v', String(n),
          '-vf', `zoompan=z=1:d=${n}:s=${VIDEO_SPEC.width}x${VIDEO_SPEC.height}:fps=${VIDEO_SPEC.fps},setsar=1,format=yuv420p`,
          '-r', String(VIDEO_SPEC.fps),
          '-c:v', 'libx264', '-preset', VIDEO_SPEC.preset, '-crf', String(VIDEO_SPEC.crf), '-tune', 'stillimage',
          '-an', tmp,
        ],
        {
          what: `renderizar a cena ${scene.n}`,
          expectedS: n / VIDEO_SPEC.fps,
          onProgress: (f) => {
            partial.set(i, f * n)
            report()
          },
        },
      )
      fs.renameSync(tmp, seg)
      partial.delete(i)
      st.cp.segments[String(scene.n)] = true
      st.save()
      framesDone += n
      report()
    }
    const parallel = getSetting(ctx.db, 'assemble.parallelSegments', z.number().int().min(1).max(8), 3)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(parallel, todo.length) }, async () => {
        while (next < todo.length) await renderOne(todo[next++]!)
      }),
    )

    // concat + áudio AAC + metadado de IA
    const list = path.join(ctx.tmpDir, 'segments.txt')
    fs.writeFileSync(list, rows.map((r) => concatListLine(path.join(st.files.segmentsDir, `${pad(r.n)}.mp4`))).join('\n'))
    const script = readScript(st)
    const tmpOut = path.join(ctx.tmpDir, 'final.mp4')
    await runFfmpeg(
      ctx.spawn,
      ctx.media,
      [
        '-f', 'concat', '-safe', '0', '-i', list,
        '-i', st.files.narration,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', VIDEO_SPEC.audioBitrate, '-ar', String(VIDEO_SPEC.audioRate), '-ac', '2',
        '-movflags', '+faststart',
        '-metadata', `title=${script.title}`,
        '-metadata', `comment=${AI_DISCLOSURE_METADATA}`,
        tmpOut,
      ],
      { what: 'montar o vídeo final', expectedS: totalMs / 1000, onProgress: (f) => ctx.stageProgress(0.7 + f * 0.3) },
    )
    finalize(st, tmpOut)
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

const TXT_LABELS: Record<Language, { tags: string; credits: string; narration: string; images: string; ownImages: string; ai: string }> = {
  'pt-BR': {
    tags: 'Tags',
    credits: 'Créditos',
    narration: 'Narração: voz sintética',
    images: 'Imagens',
    ownImages: 'Imagens: acervo próprio ou de licença livre (sem crédito exigido)',
    ai: 'Este vídeo contém conteúdo gerado ou alterado por IA (roteiro, narração e montagem).',
  },
  es: {
    tags: 'Etiquetas',
    credits: 'Créditos',
    narration: 'Narración: voz sintética',
    images: 'Imágenes',
    ownImages: 'Imágenes: acervo propio o de licencia libre (sin crédito exigido)',
    ai: 'Este video contiene contenido generado o alterado por IA (guion, narración y montaje).',
  },
  en: {
    tags: 'Tags',
    credits: 'Credits',
    narration: 'Narration: synthetic voice',
    images: 'Images',
    ownImages: 'Images: own library or free license (no credit required)',
    ai: 'This video contains AI-generated or AI-altered content (script, narration and editing).',
  },
}

/** 8.7 — move o MP4 para a pasta de saída e grava o .txt com título, descrição e créditos. */
function finalize(st: VideoJobState, tmpMp4: string): void {
  const { ctx } = st
  const outDir = getSetting(ctx.db, OUTPUT_DIR_SETTING, z.string().min(1), defaultOutputDir())
  fs.mkdirSync(outDir, { recursive: true })
  const script = readScript(st)
  const date = new Date().toISOString().slice(0, 10)
  let base = `${date} - ${slug(script.title)}`
  for (let i = 2; fs.existsSync(path.join(outDir, `${base}.mp4`)); i++) base = `${date} - ${slug(script.title)} (${i})`
  const mp4 = path.join(outDir, `${base}.mp4`)
  const txt = path.join(outDir, `${base}.txt`)

  const creditRows = ctx.db.db.select().from(credits).where(eq(credits.videoId, st.video.id)).all()
  const L = TXT_LABELS[st.language]
  const creditLines = creditRows.length > 0 ? creditRows.sort((a, b) => a.position - b.position).map((c) => `- ${c.text}`) : [`- ${L.ownImages}`]
  const text = [
    script.title,
    '',
    script.description,
    '',
    `${L.tags}: ${script.tags.join(', ')}`,
    '',
    `${L.credits}:`,
    `- ${L.narration}`,
    ...creditLines,
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
    title: script.title,
    description: script.description,
    genTimeS: Math.round(ctx.elapsedMs() / 100) / 10,
  })
}
