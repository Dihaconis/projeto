import { cn } from '@/lib/utils'

export function Progress({ value, className, tone = 'info' }: { value: number; className?: string; tone?: 'info' | 'success' | 'danger' | 'muted' }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const color = { info: 'bg-accent', success: 'bg-success', danger: 'bg-destructive', muted: 'bg-muted-foreground' }[tone]
  return (
    <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full transition-[width] duration-300', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}
