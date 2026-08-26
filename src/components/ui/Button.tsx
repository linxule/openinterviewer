import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'quiet' | 'destructive'
}

const variantClassName: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-action text-paper-1 hover:bg-action/90',
  quiet: 'border border-ink-300 bg-transparent text-ink-900 hover:bg-paper-2',
  destructive: 'bg-error text-paper-1',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cn(
        'rounded px-4 py-2 font-sans text-[15px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variantClassName[variant],
        className
      )}
      {...props}
    />
  )
})
