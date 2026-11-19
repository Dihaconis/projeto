import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium border', {
  variants: {
    tone: {
      neutral: 'bg-muted text-muted-foreground border-border',
      info: 'bg-accent/15 text-accent border-accent/30',
      success: 'bg-success/15 text-success border-success/30',
      warning: 'bg-warning/15 text-warning border-warning/30',
      danger: 'bg-destructive/15 text-destructive border-destructive/30',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
