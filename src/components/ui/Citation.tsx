'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface CitationProps {
  /** e.g. "t.4" */
  label: string
  /** Note content: quote + coordinate. */
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

/**
 * Footnote grammar, not tooltip grammar: the note unfolds in document flow
 * beneath the trigger and pushes following content down. For a margin-column
 * placement, use the controlled open/onOpenChange mode and render the note
 * inside a WithMargin margin slot instead of relying on this in-flow layout.
 */
export function Citation({ label, children, open, onOpenChange, className }: CitationProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : uncontrolledOpen
  const triggerId = useId()
  const regionId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)

  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Escape' && isOpen) {
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
  }

  return (
    <span className={cn(className)} onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        id={triggerId}
        type="button"
        aria-expanded={isOpen}
        aria-controls={regionId}
        onClick={() => setOpen(!isOpen)}
        className="rounded-[2px] border px-1 align-super font-mono text-[11px]"
        style={{ borderColor: 'rgb(var(--evidence))', color: 'rgb(var(--evidence))' }}
      >
        {label}
      </button>
      {isOpen ? (
        <span
          id={regionId}
          role="region"
          aria-labelledby={triggerId}
          className="citation-note block border-l-2 bg-paper-1 p-3 font-serif shadow-note"
          style={{ borderLeftColor: 'rgb(var(--evidence))' }}
        >
          {children}
        </span>
      ) : null}
    </span>
  )
}
