import Anthropic from '@anthropic-ai/sdk'
import type { SecretId } from '../secrets'

export interface ConnectionResult {
  ok: boolean
  message: string
  latencyMs: number
}

/**
 * "Testar conexão" (Configurações): uma chamada barata e sem custo por
 * provedor, só para validar a chave e a rede. Nunca devolve a chave.
 */
export async function testConnection(id: SecretId, key: string, opts: { azureRegion?: string; baseURL?: string } = {}): Promise<ConnectionResult> {
  const started = Date.now()
  const signal = AbortSignal.timeout(20_000)
  const done = (ok: boolean, message: string): ConnectionResult => ({ ok, message, latencyMs: Date.now() - started })
  const http = async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { headers, signal })
    if (r.ok) return done(true, 'Conexão ok.')
    if (r.status === 401 || r.status === 403) return done(false, 'Chave recusada pelo provedor (inválida ou sem permissão).')
    if (r.status === 429) return done(false, 'Limite de requisições atingido agora; a chave parece válida, tente de novo em instantes.')
    return done(false, `O provedor respondeu HTTP ${r.status}.`)
  }
  try {
    switch (id) {
      case 'anthropic': {
        const c = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20_000, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })
        await c.models.list({ limit: 1 })
        return done(true, 'Conexão ok.')
      }
      case 'openai':
        return await http(`${opts.baseURL ?? 'https://api.openai.com/v1'}/models`, { authorization: `Bearer ${key}` })
      case 'gemini':
        return await http(`${opts.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta'}/models?pageSize=1`, { 'x-goog-api-key': key })
      case 'elevenlabs':
        return await http(`${opts.baseURL ?? 'https://api.elevenlabs.io'}/v1/voices`, { 'xi-api-key': key })
      case 'azure_speech': {
        if (!opts.azureRegion) return done(false, 'Informe a região do Azure (ex.: brazilsouth) antes de testar.')
        return await http(`${opts.baseURL ?? `https://${opts.azureRegion}.tts.speech.microsoft.com`}/cognitiveservices/voices/list`, { 'Ocp-Apim-Subscription-Key': key })
      }
      case 'pexels':
        return await http(`${opts.baseURL ?? 'https://api.pexels.com/v1'}/search?query=sky&per_page=1`, { Authorization: key })
      case 'pixabay':
        return await http(`${opts.baseURL ?? 'https://pixabay.com/api/'}?${new URLSearchParams({ key, q: 'sky', per_page: '3' })}`, {})
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return done(false, 'Chave recusada pelo provedor (inválida ou sem permissão).')
    if (err instanceof Anthropic.APIError && typeof err.status === 'number') return done(false, `O provedor respondeu HTTP ${err.status}.`)
    const e = err as { name?: string }
    if (e?.name === 'TimeoutError') return done(false, 'Sem resposta em 20 s. Verifique a internet ou o proxy.')
    return done(false, 'Não foi possível conectar. Verifique a internet ou o proxy.')
  }
}
