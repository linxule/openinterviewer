import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Page({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mx-auto max-w-[66rem] px-5 md:px-12', className)} {...props} />
}

export function Measure({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('max-w-measure', className)} {...props} />
}

export interface WithMarginProps {
  main: ReactNode
  margin: ReactNode
  className?: string
}

/**
 * Grid: main column, gutter, margin column on md+. Below md, margin content
 * renders inline after main, indented with an ink-300 left border.
 */
export function WithMargin({ main, margin, className }: WithMarginProps) {
  return (
    <div className={cn('md:grid md:grid-cols-[minmax(0,34rem)_3rem_18rem]', className)}>
      <div>{main}</div>
      <div className="mt-4 border-l border-ink-300 pl-4 md:col-start-3 md:mt-0 md:border-l-0 md:pl-0">
        {margin}
      </div>
    </div>
  )
}
