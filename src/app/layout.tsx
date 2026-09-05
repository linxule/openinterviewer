import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Mono, Public_Sans, Source_Serif_4 } from 'next/font/google'
import './globals.css'
import PreviewBanner from '@/components/PreviewBanner'

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-serif',
})

const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-sans',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title: 'OpenInterviewer',
  description: 'AI-assisted qualitative research interviews with evidence-linked synthesis',
}

// A bottom-pinned composer needs the software keyboard to shrink the layout
// viewport, not just the visual one. Chromium honours interactive-widget;
// browsers that do not implement it ignore the token and keep today's
// behaviour, so this is additive. Zoom is deliberately left enabled.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${sourceSerif4.variable} ${publicSans.variable} ${ibmPlexMono.variable}`}
    >
      <body className="min-h-dvh bg-paper-0 font-sans text-ink-700 antialiased">
        <PreviewBanner />
        {children}
      </body>
    </html>
  )
}
