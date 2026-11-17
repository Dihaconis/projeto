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

/** Tipos de job. */
export const JOB_KINDS = ['video'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const LANGUAGES = ['pt-BR', 'es', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<Language, string> = {
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  en: 'English',
}

/** Taxa de fala padrão (palavras por minuto), configurável (seção 8.1). */
export const DEFAULT_WPM: Record<Language, number> = { 'pt-BR': 150, es: 160, en: 155 }

/** Duração (seção 2): padrão 7 min, faixa aceita 6–9 min. */
export const DURATION = {
  defaultS: 420,
  minS: 360,
  maxS: 540,
  /** Menor alvo aceito pela CLI para testes curtos (ex.: 60 s da Fase 2). */
  shortTestMinS: 30,
  /** Ajuste máximo de velocidade da narração (seção 8.5). */
  maxTempoAdjust: 0.08,
} as const

/**
 * Janela de duração real aceita para um alvo. Alvos de produção (6–9 min) usam
 * a faixa fechada do briefing; alvos curtos de teste usam ±15% do alvo.
 */
export function durationWindowS(targetS: number): { min: number; max: number } {
  if (targetS >= DURATION.minS) return { min: DURATION.minS, max: DURATION.maxS }
  return { min: targetS * 0.85, max: targetS * 1.15 }
}

export const VIDEO_SPEC = {
  width: 1920,
  height: 1080,
  fps: 30,
  crf: 20,
  preset: 'veryfast',
  audioBitrate: '192k',
  audioRate: 48000,
  /** Pausas entre cenas e entre atos (seção 8.5). */
  scenePauseMs: 250,
  actPauseMs: 600,
} as const

/** Texto gravado no metadado `comment` do MP4 (seção 8.7). */
export const AI_DISCLOSURE_METADATA =
  'Conteudo gerado/alterado por IA (roteiro, narracao e montagem automatizados) - MUDO'

/** Licenças aceitas (seção 9). */
export const IMAGE_LICENSES = ['cc0', 'public_domain', 'pexels', 'pixabay', 'own', 'generated'] as const
export type ImageLicense = (typeof IMAGE_LICENSES)[number]
/** Licenças que o usuário pode atribuir a imagens do próprio acervo. */
export const LIBRARY_LICENSES = ['cc0', 'public_domain', 'own'] as const

/** Imagens abaixo desta largura são descartadas (seção 8.4). */
export const MIN_IMAGE_WIDTH = 1280

/** Códigos de erro estáveis (usados em `last_error` e na saída --json da CLI). */
export const ERROR_CODES = [
  'INTERNAL',
  'CANCELLED',
  'ORPHAN_MAX_ATTEMPTS',
  'SCRIPT_SCHEMA',
  'LICENSE_MISSING',
  'QUOTA_EXCEEDED',
  'PROVIDER_REFUSAL',
  'PROVIDER_UNAVAILABLE',
  'MISSING_KEY',
  'REVIEW_REJECTED',
  'REVIEW_MANUAL',
  'DURATION_OUT_OF_RANGE',
  'FFMPEG_FAILED',
  'INVALID_INPUT',
  'IMAGES_UNAVAILABLE',
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
