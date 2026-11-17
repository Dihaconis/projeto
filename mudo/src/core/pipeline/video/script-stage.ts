import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { acts, videos } from '../../db/schema'
import { writeFileAtomic } from '../../paths'
import { buildReviewPrompt, reviewJsonSchema, reviewSchema, type ReviewIssue } from '../../prompts/review'
import {
  buildScriptPrompt,
  scriptJsonSchema,
  scriptProblems,
  scriptRetryPrompt,
  scriptSchema,
  scriptWordCount,
  type Act,
  type Script,
} from '../../prompts/script'
import { callWithFallback } from '../../providers/call'
import { stripJsonFences, type LlmOutput, type LlmProvider } from '../../providers/types'
import { JobError, NeedsInputError } from '../../queue/errors'
import { targetWords } from '../../videos'
import { loadActs, preset, readScript, updateVideo, writeScript, type VideoJobState } from './state'

async function llmCall(st: VideoJobState, stage: string, providers: LlmProvider[], system: string, prompt: string, jsonSchema: object, expectedOutputTokens: number): Promise<LlmOutput> {
  const r = await callWithFallback(providers, () => ({ system, prompt, jsonSchema: jsonSchema as Record<string, unknown>, expectedOutputTokens }), {
    db: st.ctx.db,
    log: st.ctx.log,
    signal: st.ctx.signal,
    stage,
    videoId: st.video.id,
  })
  st.ctx.addCost(r.output.costCents)
  return r.output
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stripJsonFences(text)) }
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function saveActs(st: VideoJobState, list: Act[]): void {
  const db = st.ctx.db
  db.sqlite.transaction(() => {
    db.db.delete(acts).where(eq(acts.videoId, st.video.id)).run()
    for (const a of list) {
      db.db.insert(acts).values({ id: randomUUID(), videoId: st.video.id, n: a.n, heading: a.heading, text: a.text }).run()
    }
  })()
}

/** 8.1 — roteiro com JSON validado por zod; 1 retry com o erro; depois SCRIPT_SCHEMA. */
export async function scriptStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('script')
  if (st.cp.script?.done && fs.existsSync(st.files.script) && loadActs(st).length > 0) {
    ctx.stageProgress(1)
    return
  }
  const words = targetWords(st.video.targetDurationS, st.payload.wpm)
  const recent = ctx.db.db
    .select({ title: videos.title })
    .from(videos)
    .where(and(eq(videos.channelId, st.channel.id), ne(videos.id, st.video.id), isNotNull(videos.title)))
    .orderBy(desc(videos.createdAt))
    .limit(10)
    .all()
    .map((r) => r.title ?? '')
  const { system, prompt } = buildScriptPrompt({
    theme: st.video.theme,
    language: st.language,
    targetS: st.video.targetDurationS,
    targetWords: words,
    channel: { name: st.channel.name, niche: st.channel.niche, scriptStyle: preset(st).scriptStyle },
    recentTitles: recent,
  })
  const providers = await ctx.providers.llm()
  const expected = Math.round(words * 1.6) + 400

  let currentPrompt = prompt
  let script: Script | null = null
  let lastProblems: string[] = []
  for (let attempt = 1; attempt <= 2 && !script; attempt++) {
    const out = await llmCall(st, 'script', providers, system, currentPrompt, scriptJsonSchema, expected)
    ctx.stageProgress(attempt / 2)
    const json = parseJson(out.text)
    let problems: string[]
    if (!json.ok) problems = [json.error]
    else {
      const parsed = scriptSchema.safeParse(json.value)
      problems = parsed.success
        ? scriptProblems(parsed.data, words)
        : parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      if (parsed.success && problems.length === 0) script = parsed.data
    }
    if (!script) {
      lastProblems = problems
      ctx.log.warn({ attempt, problems }, 'roteiro rejeitado na validação')
      currentPrompt = scriptRetryPrompt(prompt, out.text, problems)
    }
  }
  if (!script) {
    throw new JobError('SCRIPT_SCHEMA', `O roteiro gerado não passou na validação após 2 tentativas: ${lastProblems.join('; ')}`, false, {
      problems: lastProblems,
    })
  }
  writeScript(st, script)
  saveActs(st, script.acts)
  updateVideo(st, { title: script.title, description: script.description })
  st.cp.script = { done: true }
  st.save()
  ctx.stageProgress(1)
}

/**
 * 8.2 — revisão com rubrica. Reprovou 2× → needs_input com as issues.
 * Canal com "revisar manualmente sempre" → needs_input mesmo aprovado.
 * Ao retomar de needs_input, a decisão do usuário vale como aprovação.
 */
export async function reviewStage(st: VideoJobState): Promise<void> {
  const { ctx } = st
  ctx.enterStage('review')
  const prior = st.cp.review
  if (prior?.status === 'approved' || prior?.status === 'human') {
    ctx.stageProgress(1)
    return
  }
  if (prior?.status === 'pending_human') {
    st.cp.review = { ...prior, status: 'human' }
    st.save()
    ctx.log.info('roteiro liberado pelo usuário ao retomar')
    ctx.stageProgress(1)
    return
  }

  const words = targetWords(st.video.targetDurationS, st.payload.wpm)
  const providers = await ctx.providers.llm()
  const issues: ReviewIssue[] = []
  let script = readScript(st)
  let approved = false

  for (let round = 1; round <= 2 && !approved; round++) {
    const { system, prompt } = buildReviewPrompt({ language: st.language, theme: st.video.theme, hook: script.hook, acts: script.acts, targetWords: words })
    const out = await llmCall(st, 'review', providers, system, prompt, reviewJsonSchema, Math.round(words * 1.6) + 600)
    ctx.stageProgress(round / 2)
    const json = parseJson(out.text)
    const parsed = json.ok ? reviewSchema.safeParse(json.value) : null
    if (!parsed?.success) {
      // revisão ilegível conta como reprovação sem revisão aproveitável
      issues.push({ kind: 'coherence', act: null, note: 'A revisão automática devolveu uma resposta inválida.' })
      continue
    }
    issues.push(...parsed.data.issues)
    if (parsed.data.approved) {
      approved = true
      break
    }
    const revised = parsed.data.revisedActs
    if (revised && round < 2) {
      const candidate: Script = { ...script, acts: revised.map((a, i) => ({ ...a, n: i + 1 })) }
      const problems = scriptProblems(candidate, words)
      if (problems.length === 0) {
        script = candidate
        writeScript(st, script)
        saveActs(st, script.acts)
        ctx.log.info({ words: scriptWordCount(script.acts) }, 'roteiro revisado aplicado')
      } else {
        ctx.log.warn({ problems }, 'revisão proposta descartada (fora das regras)')
      }
    }
  }

  writeFileAtomic(st.files.review, JSON.stringify({ approved, issues }, null, 2))
  if (!approved) {
    st.cp.review = { status: 'pending_human', rounds: 2, issues }
    st.save()
    throw new NeedsInputError(
      'REVIEW_REJECTED',
      `A revisão reprovou o roteiro duas vezes. Veja os pontos levantados, edite o roteiro se quiser e retome. Pontos: ${issues
        .slice(0, 6)
        .map((i) => (i.act ? `ato ${i.act}: ${i.note}` : i.note))
        .join(' | ')}`,
      { issues },
    )
  }
  if (preset(st).manualReview) {
    st.cp.review = { status: 'pending_human', rounds: 1, issues }
    st.save()
    throw new NeedsInputError('REVIEW_MANUAL', 'Roteiro aprovado pela revisão automática. Este canal pede revisão manual: confira e retome para continuar.', {
      issues,
    })
  }
  st.cp.review = { status: 'approved', rounds: 1, issues }
  st.save()
  ctx.stageProgress(1)
}
