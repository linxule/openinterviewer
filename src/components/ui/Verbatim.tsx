import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface VerbatimProps {
  as?: 'p' | 'h1' | 'h2' | 'div' | 'blockquote'
  className?: string
  /** BCP 47 language of the text, when it differs from the page's. */
  lang?: string
  children: ReactNode
}

/** Serif delivery for verbatim/consent text. Caller supplies size/leading/color. */
export function Verbatim({ as: Tag = 'p', className, lang, children }: VerbatimProps) {
  return <Tag className={cn('font-serif', className)} lang={lang}>{children}</Tag>
}
