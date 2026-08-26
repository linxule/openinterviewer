import Link from 'next/link';
import { Label, Page } from '@/components/ui';

const cloneCommands = `git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
# Fill the required standalone values in .env.local, then:
npm run setup:check -- --mode standalone
npm run dev`;

export default function SelfHostPage() {
  return (
    <main className="min-h-dvh bg-paper-0">
      <Page className="space-y-16 py-12 md:py-20">
        <Link
          href="/"
          className="font-sans text-[13px] text-ink-500 underline underline-offset-2 hover:text-ink-900"
        >
          Back home
        </Link>

        <section className="space-y-3">
          <Label>Self-host OpenInterviewer</Label>
          <h1 className="font-sans text-[24px] font-semibold leading-[32px] text-ink-900 md:text-[32px] md:leading-[40px]">
            Your deployment, credentials, and storage
          </h1>
          <p className="max-w-measure font-sans text-[17px] leading-[28px] text-ink-700">
            Standalone mode keeps researcher credentials in your server environment. It needs Node 24.15+,
            either Vercel AI Gateway access or one Google Gemini, Anthropic Claude, OpenAI, or OpenRouter key,
            an Upstash Redis REST URL and token, and four independent secrets.
          </p>
        </section>

        <section className="space-y-4 border-t border-ink-300 pt-6">
          <h2 className="font-sans text-[15px] font-semibold text-ink-900">Agent-friendly setup</h2>
          <pre className="overflow-x-auto bg-paper-2 p-4 font-mono text-[13px] leading-[20px] text-ink-900"><code>{cloneCommands}</code></pre>
          <p className="max-w-measure font-sans text-[13px] text-ink-500">
            The setup checker reports missing variable names and invalid shapes only. It does not print values,
            write secrets, provision resources, or contact an AI provider.
          </p>
        </section>

        <section className="divide-y divide-ink-300 border-t border-ink-300">
          <div className="py-6">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Security essentials</h2>
            <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
              Keep all credentials server-only. Never reuse the admin password, session secret, participant
              secret, or rate-limit salt. Use a write-capable Redis token only on the server.
            </p>
          </div>
          <div className="py-6">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Full runbook</h2>
            <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
              The repository documents local setup, Vercel environment scoping, readiness checks, hosted BYOS,
              legacy-link retirement, staging, and rollback.
            </p>
            <a
              href="https://github.com/linxule/openinterviewer#3-run-a-self-hosted-standalone-instance"
              className="mt-3 inline-block font-sans text-[13px] font-medium text-action underline underline-offset-2"
            >
              Open the setup guide
            </a>
          </div>
        </section>
      </Page>
    </main>
  );
}
