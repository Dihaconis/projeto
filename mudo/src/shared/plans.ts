/**
 * Planos (seção 12): fonte única. Toda tela e a CLI exibem a partir daqui.
 * `null` = sem limite. Preço em centavos de real por mês.
 */
export const PLANS = [
  { id: 'ilimitado', name: 'Ilimitado (uso pessoal)', priceCents: null, videosPerMonth: null, cutsPerMonth: null },
  { id: 'inicial', name: 'Inicial', priceCents: 4900, videosPerMonth: 6, cutsPerMonth: 5 },
  { id: 'pro', name: 'Pro', priceCents: 14900, videosPerMonth: 30, cutsPerMonth: 20 },
  { id: 'elite', name: 'Elite', priceCents: 39900, videosPerMonth: 100, cutsPerMonth: 100 },
] as const

export type Plan = (typeof PLANS)[number]
export type PlanId = Plan['id']
export const PLAN_IDS = PLANS.map((p) => p.id) as [PlanId, ...PlanId[]]
export const DEFAULT_PLAN: PlanId = 'ilimitado'

export function planById(id: string): Plan {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]
}
