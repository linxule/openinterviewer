'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface TabItem<T extends string> {
  id: T
  label: string
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[]
  value: T
  onValueChange: (id: T) => void
  /** Accessible name for the tablist. */
  label: string
  /** Classes for the tablist element; the grid column count lives here. */
  className?: string
  /** Classes for the tabpanel element. */
  panelClassName?: string
  /** The active panel's content. Only the active panel is rendered. */
  children: ReactNode
}

/**
 * One accessible tab strip: roving tabindex, manual activation (arrow keys
 * move focus only; Enter/Space/click activate), a single shared tabpanel
 * whose aria-labelledby follows the selected tab. See docs/design/slice-I-spec.md I6.
 */
export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  label,
  className,
  panelClassName,
  children,
}: TabsProps<T>) {
  const baseId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusTabAt = (index: number) => {
    tabRefs.current[index]?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = tabRefs.current.findIndex((el) => el === document.activeElement)
    if (currentIndex === -1) return

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        focusTabAt((currentIndex + 1) % items.length)
        break
      case 'ArrowLeft':
        event.preventDefault()
        focusTabAt((currentIndex - 1 + items.length) % items.length)
        break
      case 'Home':
        event.preventDefault()
        focusTabAt(0)
        break
      case 'End':
        event.preventDefault()
        focusTabAt(items.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onValueChange(items[currentIndex].id)
        break
      default:
        break
    }
  }

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        className={cn('grid border-b border-ink-300', className)}
        onKeyDown={handleKeyDown}
      >
        {items.map((item, index) => {
          const selected = item.id === value
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              ref={(el) => {
                tabRefs.current[index] = el
              }}
              onClick={() => onValueChange(item.id)}
              className={cn(
                'min-h-11 border-b-2 px-2 py-3 text-center font-sans text-[15px] font-medium',
                selected ? 'border-action text-action' : 'border-transparent text-ink-500 hover:text-ink-900'
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${value}`}
        tabIndex={0}
        className={panelClassName}
      >
        {children}
      </div>
    </>
  )
}
