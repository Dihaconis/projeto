import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  JobError,
  NeedsInputError,
  ProviderRefusalError,
  ProviderTechnicalError,
  backoffMs,
  callWithFallback,
  nullLogger,
  DEFAULT_POLICY,
  type LlmProvider,
} from '../../src/core'
import { anthropicLlm } from '../../src/core/providers/llm/anthropic'
import { geminiLlm } from '../../src/core/providers/llm/gemini'
import { openAiLlm } from '../../src/core/providers/llm/openai'
import { azureTts, escapeXml } from '../../src/core/providers/tts/azure'
import { elevenLabsTts } from '../../src/core/providers/tts/elevenlabs'
import { openAiTts } from '../../src/core/providers/tts/openai'
import { downLlm, fixtureLlm, refusingLlm, type FixtureLog } from '../helpers/fixtures'
import { makeEnv, type TestEnv } from '../helpers/env'

// ---------- servidor HTTP local que imita os provedores ----------
type Handler = (req: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }) => { status: number; body: string | Buffer; type?: string }
let handler: Handler = () => ({ status: 500, body: '' })
let lastReq: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | null = null
let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      lastReq = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
      const r = handler(lastReq)
      res.writeHead(r.status, { 'content-type': r.type ?? 'application/json' })
      res.end(r.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())

const llmIn = { system: 'sys', prompt: 'p', jsonSchema: { type: 'object' }, expectedOutputTokens: 10 }
const sig = () => new AbortController().signal

describe('adaptadores de LLM', () => {
  it('Anthropic: envia output_config com JSON schema, lê texto e uso; recusa vira ProviderRefusalError', async () => {
    const p = anthropicLlm({ apiKey: 'sk-test-123', baseURL: base, model: 'claude-opus-5-5' })
    handler = () => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    })
    const out = await p.call(llmIn, sig())
    expect(out.text).toBe('{"ok":true}')
    expect(out.costCents).toBeCloseTo(((1000 * 4 + 500 * 20) / 1e6) * 100)
    const sent = JSON.parse(lastReq!.body)
    expect(lastReq!.url).toBe('/v1/messages')
    expect(lastReq!.headers.authorization).toBe('Bearer sk-test-123')
    expect(sent.output_config.format).toEqual({ type: 'json_schema', schema: { type: 'object' } })
    expect(sent.fallbacks).toBeUndefined() // sem fallback de modelo para contornar recusa

    handler = () => ({
      status: 200,
      body: JSON.stringify({
        id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [],
        stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'não posso ajudar com isso' },
        stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      }),
    })
    await expect(p.call(llmIn, sig())).rejects.toBeInstanceOf(ProviderRefusalError)

    handler = () => ({ status: 529, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) })
    const e = await p.call(llmIn, sig()).catch((x) => x)
    expect(e).toBeInstanceOf(ProviderTechnicalError)
    expect(e.retryable).toBe(true)
    expect(String(e.message)).not.toContain('sk-test-123')
  })

  it('OpenAI: json_schema, refusal e content_filter', async () => {
    const p = openAiLlm({ apiKey: 'k', baseURL: base, model: 'gpt-5' })
    handler = () => ({ status: 200, body: JSON.stringify({ model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { content: '{"a":1}', refusal: null } }], usage: { prompt_tokens: 5, completion_tokens: 6 } }) })
    expect((await p.call(llmIn, sig())).text).toBe('{"a":1}')
    expect(JSON.parse(lastReq!.body).response_format.type).toBe('json_schema')
    expect(lastReq!.headers.authorization).toBe('Bearer k')
    handler = () => ({ status: 200, body: JSON.stringify({ model: 'gpt-5', choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I can’t help with that.' } }], usage: { prompt_tokens: 5, completion_tokens: 0 } }) })
    await expect(p.call(llmIn, sig())).rejects.toBeInstanceOf(ProviderRefusalError)
    handler = () => ({ status: 200, body: JSON.stringify({ model: 'gpt-5', choices: [{ finish_reason: 'content_filter', message: { content: '' } }], usage: { prompt_tokens: 5, completion_tokens: 0 } }) })
    await expect(p.call(llmIn, sig())).rejects.toBeInstanceOf(ProviderRefusalError)
    handler = () => ({ status: 429, body: '{"error":"rate"}' })
    const e = await p.call(llmIn, sig()).catch((x) => x)
    expect(e).toMatchObject({ retryable: true, status: 429 })
  })

  it('Gemini: chave no cabeçalho (nunca na URL), bloqueio vira recusa', async () => {
    const p = geminiLlm({ apiKey: 'gkey', baseURL: base, model: 'gemini-x' })
    handler = () => ({ status: 200, body: JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"b":2}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }) })
    expect((await p.call(llmIn, sig())).text).toBe('{"b":2}')
    expect(lastReq!.url).toBe('/models/gemini-x:generateContent')
    expect(lastReq!.url).not.toContain('gkey')
    expect(lastReq!.headers['x-goog-api-key']).toBe('gkey')
    handler = () => ({ status: 200, body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) })
    await expect(p.call(llmIn, sig())).rejects.toBeInstanceOf(ProviderRefusalError)
  })
})

describe('adaptadores de TTS', () => {
  const ttsIn = { text: 'Olá <mundo> & "amigos"', voiceId: 'v1', language: 'pt-BR' as const }

  it('ElevenLabs: endpoint com timestamps por caractere', async () => {
    const p = elevenLabsTts({ apiKey: 'xi', baseURL: base })
    handler = () => ({
      status: 200,
      body: JSON.stringify({ audio_base64: Buffer.from('ID3fakeaudio').toString('base64'), alignment: { characters: ['O', 'l'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } }),
    })
    const out = await p.call(ttsIn, sig())
    expect(lastReq!.url).toBe('/v1/text-to-speech/v1/with-timestamps?output_format=mp3_44100_128')
    expect(lastReq!.headers['xi-api-key']).toBe('xi')
    expect(out.audio.toString()).toBe('ID3fakeaudio')
    expect(out.alignment?.startS).toEqual([0, 0.1])
  })

  it('OpenAI TTS devolve o binário; Azure monta SSML escapado', async () => {
    handler = () => ({ status: 200, body: Buffer.from('mp3bytes'), type: 'audio/mpeg' })
    const o = await openAiTts({ apiKey: 'k', baseURL: base }).call(ttsIn, sig())
    expect(o.audio.toString()).toBe('mp3bytes')
    const a = await azureTts({ apiKey: 'az', region: 'brazilsouth', baseURL: base }).call({ ...ttsIn, voiceId: 'pt-BR-FranciscaNeural' }, sig())
    expect(a.audio.toString()).toBe('mp3bytes')
    expect(lastReq!.headers['ocp-apim-subscription-key']).toBe('az')
    expect(lastReq!.body).toContain(escapeXml(ttsIn.text))
    expect(lastReq!.body).not.toContain('<mundo>')
  })
})

describe('política de chamada (seção 7)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())
  const ctx = (sleeps: number[] = []) => ({
    db: env.handle,
    log: nullLogger(),
    signal: new AbortController().signal,
    stage: 'script',
    videoId: null,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
  })

  it('backoff exponencial com jitter dentro de [50%,100%] do teto', () => {
    expect(backoffMs(1, DEFAULT_POLICY, () => 0)).toBe(500)
    expect(backoffMs(1, DEFAULT_POLICY, () => 1)).toBe(1000)
    expect(backoffMs(3, DEFAULT_POLICY, () => 1)).toBe(4000)
    expect(backoffMs(10, DEFAULT_POLICY, () => 1)).toBe(15_000)
  })

  it('erro técnico: 3 tentativas com espera, depois o próximo provedor; tudo em provider_log', async () => {
    const log: FixtureLog = { calls: [] }
    const sleeps: number[] = []
    const r = await callWithFallback([downLlm('a', log), fixtureLlm('b', log)], () => llmIn, ctx(sleeps))
    expect(r.providerId).toBe('b')
    expect(log.calls.map((c) => c.provider)).toEqual(['a', 'a', 'a', 'b'])
    expect(sleeps).toHaveLength(2)
    const rows = env.handle.sqlite.prepare('SELECT provider, outcome FROM provider_log ORDER BY id').all()
    expect(rows).toEqual([
      { provider: 'a', outcome: 'error' },
      { provider: 'a', outcome: 'error' },
      { provider: 'a', outcome: 'error' },
      { provider: 'b', outcome: 'ok' },
    ])
  })

  it('recusa: needs_input na hora, sem tentar o próximo', async () => {
    const log: FixtureLog = { calls: [] }
    const e = await callWithFallback([refusingLlm('r', log), fixtureLlm('b', log)], () => llmIn, ctx()).catch((x) => x)
    expect(e).toBeInstanceOf(NeedsInputError)
    expect(e.code).toBe('PROVIDER_REFUSAL')
    expect(log.calls.map((c) => c.provider)).toEqual(['r'])
  })

  it('todos fora → PROVIDER_UNAVAILABLE retomável; nenhum configurado → MISSING_KEY', async () => {
    const e = await callWithFallback([downLlm('a'), downLlm('b')], () => llmIn, ctx()).catch((x) => x)
    expect(e).toBeInstanceOf(JobError)
    expect(e).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true })
    const m = await callWithFallback<LlmProvider>([], () => llmIn, ctx()).catch((x) => x)
    expect(m).toMatchObject({ code: 'MISSING_KEY' })
  })
})
