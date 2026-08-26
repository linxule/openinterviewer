import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/** Mono, machine-verifiable facts: turn numbers, timestamps, model ids. */
export function Coordinate({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'font-mono text-[12px] text-ink-500 [font-variant-numeric:tabular-nums]',
        className
      )}
      {...props}
    />
  )
}
