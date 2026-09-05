import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Label } from './Label'

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'neutral' | 'error' | 'success'
  /** Label eyebrow above the body. Omit for a body-only notice. */
  eyebrow?: ReactNode
  children: ReactNode
}

const toneBorder: Record<NonNullable<NoticeProps['tone']>, string> = {
  neutral: 'border-ink-500',
  error: 'border-error',
  success: 'border-success',
}

export function Notice({ tone = 'neutral', eyebrow, children, className, ...props }: NoticeProps) {
  return (
    <div className={cn('border-l-2 bg-paper-2 px-4 py-3', toneBorder[tone], className)} {...props}>
      {eyebrow ? <Label>{eyebrow}</Label> : null}
      {children}
    </div>
  )
}
