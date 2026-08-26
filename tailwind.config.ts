import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        paper: {
          0: 'rgb(var(--paper-0) / <alpha-value>)',
          1: 'rgb(var(--paper-1) / <alpha-value>)',
          2: 'rgb(var(--paper-2) / <alpha-value>)',
          pop: 'rgb(var(--paper-pop) / <alpha-value>)',
        },
        ink: {
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          500: 'rgb(var(--ink-500) / <alpha-value>)',
          300: 'rgb(var(--ink-300) / <alpha-value>)',
          200: 'rgb(var(--ink-200) / <alpha-value>)',
        },
        action: 'rgb(var(--action) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        error: 'rgb(var(--error) / <alpha-value>)',
      },
      maxWidth: {
        measure: '34rem',
      },
      boxShadow: {
        note: 'var(--shadow-note)',
      },
    },
  },
  plugins: [],
}
export default config
