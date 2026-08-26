import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Coordinate } from './Coordinate'

export interface TurnProps extends HTMLAttributes<HTMLDivElement> {
  speaker: 'interviewer' | 'participant'
  turnIndex?: number
  /** Default false — participant live view never shows the coordinate. */
  showCoordinate?: boolean
  children: ReactNode
}

export function Turn({
  speaker,
  turnIndex,
  showCoordinate = false,
  children,
  className,
  ...props
}: TurnProps) {
  const showCoord = showCoordinate && turnIndex !== undefined

  return (
    <div className={cn(showCoord && 'md:grid md:grid-cols-[3rem_1fr] md:gap-3', className)} {...props}>
      {showCoord ? (
        <Coordinate className="mb-1 block md:mb-0 md:pt-1 md:text-right">t. {turnIndex}</Coordinate>
      ) : null}
      <div
        className={
          speaker === 'participant'
            ? 'pl-8 font-serif text-[19px] leading-[31px] text-ink-900'
            : 'font-sans text-[16px] leading-[26px] text-ink-500'
        }
      >
        {children}
      </div>
    </div>
  )
}
