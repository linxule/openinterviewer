import Link from 'next/link';
import { Label, Page } from '@/components/ui';

const cloneCommands = `git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
# Fill the required standalone values in .env.local, then:
npm run setup:check -- --mode standalone
npm run dev`;

const cloudflareCommands = `npm ci
npm run build:cloudflare
npm run check:cloudflare -- --skip-build
npm run setup:cloudflare -- plan --install <name> --env production --provider <provider> --jurisdiction eu
# Review the plan, then pipe the admin password and provider key from your secret
# manager, or omit --secrets-stdin for a hidden prompt. Keep the template (op://
# references only) outside the checkout: an untracked file there blocks apply.
op inject -i ~/secure/secrets.tpl.json | npm run setup:cloudflare -- apply --install <name> \\
  --env production --provider <provider> --jurisdiction eu --secrets-stdin --yes \\
  --operator-token-file <path outside the repository>
npm run setup:cloudflare -- verify --install <name> --env production`;

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
            Standalone mode keeps researcher credentials in your server environment. On Node or Vercel it needs
            Node 24.19+, either Vercel AI Gateway access or one Google Gemini, Anthropic Claude, OpenAI, or
            OpenRouter key, an Upstash Redis REST URL and token, and four independent secrets.
          </p>
          <p className="max-w-measure font-sans text-[17px] leading-[28px] text-ink-700">
            On Cloudflare it runs as one Worker with a Durable Object for storage and a Queue for background
            analysis. It needs an admin password of 16 to 1,009 ASCII characters (sign-in requests are limited to
            1 KiB, so multi-byte characters lower the maximum), the default provider&apos;s key (other providers&apos; keys
            can be added later) and no Redis; the installer generates the other secrets and the recovery epoch.
            Provider requests go directly to each provider or, if you choose, through your own Cloudflare AI
            Gateway with logging and caching turned off.
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

        <section className="space-y-4 border-t border-ink-300 pt-6">
          <h2 className="font-sans text-[15px] font-semibold text-ink-900">Cloudflare installer</h2>
          <pre className="overflow-x-auto bg-paper-2 p-4 font-mono text-[13px] leading-[20px] text-ink-900"><code>{cloudflareCommands}</code></pre>
          <p className="max-w-measure font-sans text-[13px] text-ink-500">
            The plan is read-only. Apply creates only the named Worker (with its Durable Object), Queue and
            dead-letter queue, sends secrets through stdin, and records a non-secret receipt. Choose the storage
            jurisdiction before the first install; changing it later is a migration. Workers Paid is recommended:
            the Free plan allows 10 ms of CPU time per request.
          </p>
        </section>

        <section className="divide-y divide-ink-300 border-t border-ink-300">
          <div className="py-6">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Security essentials</h2>
            <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
              Keep all credentials server-only. Never reuse the admin password, session secret, participant
              secret, rate-limit salt, or operator token. Use a write-capable Redis token only on the server.
            </p>
          </div>
          <div className="py-6">
            <h2 className="font-sans text-[15px] font-semibold text-ink-900">Full runbook</h2>
            <p className="mt-2 max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
              The repository documents local setup, Vercel environment scoping, the Cloudflare installer and
              operator runbook, readiness checks, hosted BYOS, legacy-link retirement, staging, and rollback.
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
