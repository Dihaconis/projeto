/**
 * Preços de referência usados em `estimateCost` e no custo registrado. Valores
 * em US$ por unidade, conferidos nas páginas públicas dos provedores; podem ser
 * sobrescritos em Configurações (chave `pricing.<provider>.<model>`).
 */
export interface LlmPrice {
  inPerMTok: number
  outPerMTok: number
}

export const LLM_PRICES: Record<string, LlmPrice> = {
  'claude-opus-5-5': { inPerMTok: 4, outPerMTok: 20 },
  'claude-sonnet-5-5': { inPerMTok: 2, outPerMTok: 10 },
  'claude-haiku-5-5': { inPerMTok: 0.1, outPerMTok: 0.5 },
}

/** Preço genérico quando o modelo configurado não está na tabela. */
export const FALLBACK_LLM_PRICE: LlmPrice = { inPerMTok: 5, outPerMTok: 25 }

/** US$ por 1 milhão de caracteres de TTS. */
export const TTS_PRICE_PER_MCHAR: Record<string, number> = {
  elevenlabs: 180,
  openai: 15,
  azure: 16,
}

export function llmCostCents(model: string, tokensIn: number, tokensOut: number, table = LLM_PRICES): number {
  const p = table[model] ?? FALLBACK_LLM_PRICE
  return ((tokensIn * p.inPerMTok + tokensOut * p.outPerMTok) / 1_000_000) * 100
}

export function ttsCostCents(provider: string, chars: number): number {
  const p = TTS_PRICE_PER_MCHAR[provider] ?? 30
  return ((chars * p) / 1_000_000) * 100
}

/** Estimativa grosseira de tokens a partir do texto (≈ 4 caracteres/token). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
