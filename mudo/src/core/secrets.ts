import { z } from 'zod'

/** Chaves de API que o app guarda (cifradas com safeStorage, seção 7). */
export const SECRET_IDS = ['anthropic', 'openai', 'gemini', 'elevenlabs', 'azure_speech', 'pexels', 'pixabay'] as const
export type SecretId = (typeof SECRET_IDS)[number]
export const secretIdSchema = z.enum(SECRET_IDS)

export const SECRET_LABELS: Record<SecretId, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  elevenlabs: 'ElevenLabs',
  azure_speech: 'Azure AI Speech',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
}

/**
 * Acesso somente-leitura às chaves. O core nunca sabe como elas são guardadas:
 * no app vem do main (safeStorage), na CLI de um processo auxiliar do app.
 * O valor nunca vai para log, banco ou renderer.
 */
export interface SecretStore {
  get(id: SecretId): Promise<string | null>
}

/** Formato de `%APPDATA%/MUDO/config.json`: só valores cifrados (base64). */
export const configFileSchema = z.object({
  version: z.literal(1),
  secrets: z.partialRecord(secretIdSchema, z.string()).default({}),
})
export type ConfigFile = z.infer<typeof configFileSchema>

/** Protocolo do processo auxiliar de chaves (uma linha JSON de pedido, uma de resposta). */
export const secretsHelperRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), id: secretIdSchema }),
  z.object({ op: z.literal('set'), id: secretIdSchema, value: z.string().min(1).max(4096) }),
  z.object({ op: z.literal('delete'), id: secretIdSchema }),
  z.object({ op: z.literal('list') }),
])
export type SecretsHelperRequest = z.infer<typeof secretsHelperRequestSchema>

export const secretsHelperResponseSchema = z.union([
  z.object({ ok: z.literal(true), value: z.string().nullable().optional(), configured: z.array(secretIdSchema).optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type SecretsHelperResponse = z.infer<typeof secretsHelperResponseSchema>

/** Valor que aparece em vez da chave sempre que algo precisa "mostrá-la". */
export function maskSecret(v: string): string {
  return v.length <= 8 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-2)}`
}
