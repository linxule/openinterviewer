import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface DisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  children: ReactNode
}

/** Interruptive filled ochre band. No dismiss affordance — see DIRECTION-final.md. */
export function Disclosure({ title, children, className, style, ...props }: DisclosureProps) {
  return (
    <div
      role="note"
      className={cn('px-4 py-3 text-[14px] font-medium', className)}
      style={{
        backgroundColor: 'rgb(var(--disclosure))',
        color: 'rgb(var(--disclosure-ink))',
        ...style,
      }}
      {...props}
    >
      {title ? <strong className="font-semibold">{title} </strong> : null}
      {children}
    </div>
  )
}
