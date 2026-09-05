// Path data adapted from Lucide (https://lucide.dev), ISC License.
import { cn } from '@/lib/cn'

export type IconName = 'close' | 'copy' | 'external' | 'chevron' | 'check' | 'alert'

export interface IconProps {
  name: IconName
  /** 16 for inline row controls, 18 for buttons. Default 16. */
  size?: 16 | 18
  className?: string
}

const paths: Record<IconName, string[]> = {
  close: ['M18 6 6 18M6 6l12 12'],
  copy: [
    'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z',
    'M4 16V5a1 1 0 0 1 1-1h11',
  ],
  external: ['M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  chevron: ['m6 9 6 6 6-6'],
  check: ['M20 6 9 17l-5-5'],
  alert: ['M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'],
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', className)}
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
