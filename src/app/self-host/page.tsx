import Link from 'next/link';
import { ArrowLeft, ExternalLink, ShieldCheck, Terminal } from 'lucide-react';

const cloneCommands = `git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
npm run setup:check -- --mode standalone
npm run dev`;

export default function SelfHostPage() {
  return (
    <main className="min-h-screen bg-stone-900 px-6 py-12 text-stone-100">
      <div className="mx-auto max-w-3xl space-y-8">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-stone-400 hover:text-white">
          <ArrowLeft size={16} /> Back home
        </Link>

        <section className="space-y-3">
          <p className="text-sm uppercase tracking-wide text-stone-500">Self-host OpenInterviewer</p>
          <h1 className="text-3xl font-bold">Your deployment, credentials, and storage</h1>
          <p className="text-stone-400">
            Standalone mode keeps researcher credentials in your server environment. It needs Node 24.15+,
            one Gemini or Claude key, an Upstash Redis REST URL and token, and four independent secrets.
          </p>
        </section>

        <section className="rounded-2xl border border-stone-700 bg-stone-800/60 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Terminal size={20} className="text-stone-300" />
            <h2 className="font-semibold">Agent-friendly setup</h2>
          </div>
          <pre className="overflow-x-auto rounded-xl bg-stone-950 p-4 text-sm text-stone-300"><code>{cloneCommands}</code></pre>
          <p className="text-sm text-stone-400">
            The setup checker reports missing variable names and invalid shapes only. It does not print values,
            write secrets, provision resources, or contact an AI provider.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-stone-700 p-5">
            <ShieldCheck size={20} className="mb-3 text-stone-300" />
            <h2 className="font-semibold">Security essentials</h2>
            <p className="mt-2 text-sm text-stone-400">
              Keep all credentials server-only. Never reuse the admin password, session secret, participant
              secret, or rate-limit salt. Use a write-capable Redis token only on the server.
            </p>
          </div>
          <div className="rounded-2xl border border-stone-700 p-5">
            <ExternalLink size={20} className="mb-3 text-stone-300" />
            <h2 className="font-semibold">Full runbook</h2>
            <p className="mt-2 text-sm text-stone-400">
              The repository documents local setup, Vercel environment scoping, readiness checks, hosted BYOS,
              legacy-link retirement, staging, and rollback.
            </p>
            <a
              href="https://github.com/linxule/openinterviewer#3-run-a-self-hosted-standalone-instance"
              className="mt-4 inline-flex items-center gap-2 text-sm text-stone-200 underline underline-offset-4"
            >
              Open the setup guide <ExternalLink size={14} />
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}
