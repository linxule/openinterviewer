// The app's own 404. Next's built-in one ships an unlayered `body { background: #fff }`,
// which outranks the layered Tailwind 4 utilities on <body> (bg-paper-0).
import Link from 'next/link'
import { Label, Page, Verbatim } from '@/components/ui'

export default function NotFound() {
  return (
    <main className="min-h-dvh bg-paper-0">
      <Page className="space-y-4 py-12 md:py-20">
        <Label className="block">404</Label>
        <Verbatim as="h1" className="text-[32px] font-normal leading-[40px] text-ink-900">
          This page could not be found.
        </Verbatim>
        <p className="font-sans text-[15px] leading-[24px] text-ink-700">
          <Link href="/" className="text-action underline underline-offset-2">Go to the start page</Link>
        </p>
      </Page>
    </main>
  )
}
