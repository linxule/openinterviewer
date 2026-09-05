import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

export interface ExternalLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'> {
  href: string
  children: ReactNode
}

/**
 * The external mark, once (C4/D6): opens in a new tab, marked inline on the
 * baseline with a teal-colored Icon, and announces "(opens in a new tab)" to
 * assistive technology. `target`/`rel` are omitted from the prop type so no
 * call site can weaken them.
 */
export function ExternalLink({ href, children, className, ...props }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-baseline gap-1', className)}
      {...props}
    >
      {children}
      <Icon name="external" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
