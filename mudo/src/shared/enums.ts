/**
 * Enums e constantes compartilhadas entre core, main, runner, renderer e CLI.
 * Fonte única: nenhuma tela ou módulo redefine estes valores.
 */

/** Estado do ciclo de vida do job (seção 4). */
export const JOB_STATES = ['queued', 'running', 'needs_input', 'done', 'failed', 'cancelled'] as const
export type JobState = (typeof JOB_STATES)[number]

/** Estados terminais: nenhum runner mexe mais no job sem ação do usuário. */
export const TERMINAL_STATES: readonly JobState[] = ['done', 'failed', 'cancelled']

/** Etapas do pipeline, sempre nesta ordem (seção 1). */
export const STAGES = ['script', 'review', 'images', 'tts', 'assemble'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<Stage, string> = {
  script: 'Roteiro',
  review: 'Revisão',
  images: 'Imagens',
  tts: 'Narração',
  assemble: 'Montagem',
}

export const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: 'Na fila',
  running: 'Em execução',
  needs_input: 'Aguardando você',
  done: 'Pronto',
  failed: 'Falhou',
  cancelled: 'Cancelado',
}

/**
 * Tipos de job. `selftest` é o job de teste da Fase 1 (apenas transiciona
 * estados e grava checkpoints); será removido na Fase 2, quando `video` entra.
 */
export const JOB_KINDS = ['selftest'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const LANGUAGES = ['pt-BR', 'es', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

/** Códigos de erro estáveis (usados em `last_error` e na saída --json da CLI). */
export const ERROR_CODES = [
  'INTERNAL',
  'CANCELLED',
  'ORPHAN_MAX_ATTEMPTS',
  'SCRIPT_SCHEMA',
  'LICENSE_MISSING',
  'QUOTA_EXCEEDED',
  'PROVIDER_REFUSAL',
  'SELFTEST_FAILURE',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const DEFAULTS = {
  /** Jobs simultâneos no runner (seção 4). */
  concurrency: 2,
  /** Montagem limitada a 1 por vez (seção 4). */
  assembleConcurrency: 1,
  /** Job com heartbeat mais velho que isto é órfão (seção 4). */
  orphanAfterMs: 60_000,
  heartbeatMs: 5_000,
  reaperIntervalMs: 15_000,
  maxAttempts: 3,
} as const
