import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger } from 'pino'
import pinoRoll from 'pino-roll'

export type { Logger }

/**
 * Caminhos redigidos em qualquer log. Chaves de API nunca devem chegar aqui,
 * mas, se chegarem por engano dentro de um objeto, saem como "[redacted]".
 */
export const REDACT_PATHS = [
  'apiKey',
  'key',
  'token',
  'authorization',
  'password',
  'secret',
  '*.apiKey',
  '*.key',
  '*.token',
  '*.authorization',
  '*.password',
  '*.secret',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["xi-api-key"]',
  '*.headers.authorization',
  '*.headers["x-api-key"]',
  '*.headers["xi-api-key"]',
]

/** Logger com arquivo rotativo diário/por tamanho em `logsDir/<name>.N.log`. */
export async function createLogger(logsDir: string, name: string, level = 'info'): Promise<Logger> {
  fs.mkdirSync(logsDir, { recursive: true })
  const stream = await pinoRoll({
    file: path.join(logsDir, name),
    extension: '.log',
    frequency: 'daily',
    size: '10m',
    limit: { count: 7 },
    mkdir: true,
  })
  return pino({ name, level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream)
}

/** Logger silencioso para testes e uso embutido. */
export function nullLogger(): Logger {
  return pino({ level: 'silent' })
}
