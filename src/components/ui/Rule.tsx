import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface RuleProps extends HTMLAttributes<HTMLHRElement> {
  strong?: boolean
}

export const Rule = forwardRef<HTMLHRElement, RuleProps>(function Rule(
  { strong = false, className, ...props },
  ref
) {
  return (
    <hr
      ref={ref}
      className={cn('border-0 border-t', strong ? 'border-ink-500' : 'border-ink-300', className)}
      {...props}
    />
  )
})
