import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Label } from './Label'

const controlClassName =
  'bg-paper-2 border border-ink-300 rounded px-3 py-2 text-ink-900 font-sans'

export interface FieldProps {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  children: ReactElement<{ className?: string; id?: string }>
  className?: string
}

/**
 * Labeled form control wrapper. The control is nested inside the <label> so
 * association is structural (implicit) even when htmlFor is omitted; passing
 * htmlFor also wires an explicit id for belt-and-suspenders association.
 */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  let control: ReactNode = children

  if (isValidElement(children)) {
    if (children.type === Fragment) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          'Field: a Fragment child cannot receive the injected id/className — wrap the control in a single element instead.'
        )
      }
    } else {
      control = cloneElement(children, {
        id: htmlFor ?? children.props.id,
        className: cn(controlClassName, children.props.className),
      })
    }
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor}>
        <Label>{label}</Label>
        {control}
      </label>
      {error ? (
        <p className="text-[13px] text-error">{error}</p>
      ) : hint ? (
        <p className="text-[13px] text-ink-500">{hint}</p>
      ) : null}
    </div>
  )
}
