import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface VerbatimProps {
  as?: 'p' | 'h1' | 'h2' | 'div' | 'blockquote'
  className?: string
  children: ReactNode
}

/** Serif delivery for verbatim/consent text. Caller supplies size/leading/color. */
export function Verbatim({ as: Tag = 'p', className, children }: VerbatimProps) {
  return <Tag className={cn('font-serif', className)}>{children}</Tag>
}
