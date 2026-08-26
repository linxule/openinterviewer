import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface LabelProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'default' | 'evidence' | 'disclosure'
}

const toneColor: Record<'evidence' | 'disclosure', string> = {
  evidence: 'rgb(var(--evidence))',
  disclosure: 'rgb(var(--disclosure))',
}

export function Label({ tone = 'default', className, style, ...props }: LabelProps) {
  return (
    <span
      className={cn(
        'text-[11px] font-semibold uppercase tracking-[0.08em]',
        tone === 'default' && 'text-ink-500',
        className
      )}
      style={tone === 'default' ? style : { color: toneColor[tone], ...style }}
      {...props}
    />
  )
}
