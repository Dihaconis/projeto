import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatMoney(cents: number): string {
  return `US$ ${(cents / 100).toFixed(2)}`
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Aviso de divulgação de IA (seção 8.7) — sempre ativo. */
export const AI_PUBLISH_NOTICE = 'Ao publicar, marque a opção de conteúdo alterado ou sintético da plataforma — o metadado do arquivo não faz isso sozinho.'
