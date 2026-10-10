# OpenInterviewer

OpenInterviewer is an open-source platform for adaptive, AI-assisted qualitative interviews. Researchers configure a study, share an opaque participant link, and review transcripts and synthesis in a dashboard. An AI interviewer conducts each interview, and the transcript is saved before any analysis runs.

The latest release is 5.4.0, which adds on-device voice input and analysis files in the study export. Read the [5.4.0 release notes](docs/releases/v5.4.0.md) or [all release notes](docs/releases/).

The project's own instance is [open-interview.linxule.com](https://open-interview.linxule.com). It is a standalone installation on Cloudflare, with an EU-jurisdiction workspace and provider calls through its own Cloudflare AI Gateway. The former address, `openinterviewer.vercel.app`, redirects there.

## What it does

As of 5.4.0, OpenInterviewer offers:

- adaptive interviews with 3 structure modes and an editable interviewer manner
- 4 AI providers (Google Gemini, Anthropic Claude, OpenAI and OpenRouter), called directly or through Vercel AI Gateway or your own Cloudflare AI Gateway
- opaque, revision-bound participant links and server-recorded consent
- a per-study choice of what participants are told about the AI provider
- interviews in English, Simplified Chinese, French, Japanese, Korean and Spanish, with analysis in a per-installation language
- voice input, transcribed by the installation, by the browser's dictation, or locally in desktop Chrome
- save-first completion, with per-interview synthesis, aggregate analysis and follow-up study generation
- **Explore**, which answers questions against saved transcripts with located quotations
- study and workspace ZIP exports with analysis-ready JSONL and CSV files, and Markdown transcript exports
- projects to group studies, on standalone installations
- study pause, resume and deletion, and limits on researcher AI requests
- a keyless demo that needs no provider or database

The [research guide](docs/research-guide.md) explains how each of these works.

## Ways to use it

| Option | Credentials | Where data is stored | Use it to |
| --- | --- | --- | --- |
| Keyless public demo (`/demo`) | None | Nowhere | See the participant and analysis experience with scripted sample data |
| Self-host on Cloudflare (recommended) | Server-side provider keys: the default provider's, plus any of the other 3 | A SQLite Durable Object in your Cloudflare account (no Upstash) | Run your own instance on Cloudflare Workers with durable background analysis; the project's own instance runs this way |
| Self-host on Node or Vercel | Vercel AI Gateway/OIDC or server-side provider keys | Your deployment's Upstash database | Run your own instance on Vercel or any Node host |
| Hosted researcher accounts | Sign in, then add your own AI and Upstash credentials in the UI | Your Upstash database | Use a multi-tenant service that an operator runs on the Node/Vercel target; the project does not currently operate one |

### Try the keyless demo

Open `/demo` on a running instance. It needs no login, provider key or database. The demo is deterministic, calls no AI provider and saves nothing. Every response, follow-up and insight is pre-written and visibly labeled as synthetic. It shows the participant-to-researcher workflow, not model quality. Real interviews need configured inference access and storage.

### Use a hosted researcher account

In hosted mode, a platform operator configures the application once. Researchers sign in with OAuth, then add their own AI key and Upstash database in the app. Their credentials are encrypted at rest, and the operator's keys never stand in for a missing researcher key. Operators should read the [hosted operations guide](docs/operations/hosted.md).

### Self-host an instance

A standalone instance has one researcher login (`ADMIN_PASSWORD`) and the instance's own provider keys. Two targets run the same application:

| | Cloudflare (recommended) | Node/Vercel |
| --- | --- | --- |
| Runtime | One Worker: the Next.js app via OpenNext, a SQLite Durable Object workspace, and a Queue for background analysis | Next.js on Vercel or any Node host |
| Storage | Durable Object in your Cloudflare account, with a chosen jurisdiction (`eu` recommended) | Your Upstash Redis database |
| Provider transport | Direct, or your installation's own Cloudflare AI Gateway | Direct, or Vercel AI Gateway |
| Install and update | `npm run setup:cloudflare` (guided installer: plan, apply, resume, update, verify) | Vercel project settings, or your Node host's |
| Operations | Maintenance modes, backup/import and point-in-time restore via `npm run operator:cloudflare` | Upstash backups and your host's tooling |

To try the application locally without any account or credentials, run `npm ci && npm run build:cloudflare && npm run preview:cloudflare`. The built Worker runs in local workerd with synthetic provider responses and throwaway storage.

On Cloudflare, build and check a release artifact on a clean checkout, then plan the installation:

```bash
npm ci
npm run build:cloudflare
npm run check:cloudflare -- --skip-build
npm run setup:cloudflare -- plan --install <name> --env production --provider openai --jurisdiction eu
```

Then run `apply` with credentials piped on stdin from a secret manager, and `verify`. Never keep credentials in a file inside the checkout. Choose the jurisdiction before the first install, because changing it later is a migration. Follow [Self-host on Cloudflare](docs/self-hosting-cloudflare.md) for the full steps.

On Node or Vercel, you need Node.js 24.19 or newer, an Upstash Redis database, and either Vercel AI Gateway or a provider key. Configure the standalone section of `.env.local`, then check it and start the app:

```bash
git clone https://github.com/linxule/openinterviewer.git
cd openinterviewer
npm ci
cp .env.example .env.local
npm run setup:check -- --mode standalone
npm run dev
```

Follow [Self-host on Node or Vercel](docs/self-hosting-node.md) for the variables, the Vercel deploy and the setup checker.

### Check a running instance

Deployment mode and persistent-workspace health are runtime state, so check them on the instance:

- `/api/config/mode` reports the active mode and whether the configuration shape is valid
- `/api/config/readiness` exposes the same safe configuration contract for setup UI
- `/api/health/ready` also checks the mode-specific database, and returns `503` when the application cannot serve persistent researcher workflows

Both configuration endpoints also report `analysisExecution`. It is `synchronous` on Node/Vercel deployments and `queued-v2` on Cloudflare, where analysis runs as a durable background job.

## Security and data boundaries

OpenInterviewer is built to keep participants' data and researchers' credentials within known limits:

- Provider and storage credentials stay server-side. No secret belongs in a `NEXT_PUBLIC_` variable.
- Hosted credentials are encrypted at rest with a versioned AES-256-GCM keyring.
- Researcher and participant sessions use separate signing secrets and token types.
- Participant URLs contain high-entropy opaque codes, not study configuration or reusable API bearer JWTs.
- The opaque code is exchanged for a short-lived HttpOnly, `SameSite=Strict` cookie and removed from the address bar.
- Participant APIs resolve the live, server-owned study revision and recheck link status.
- AI failures are errors, not fabricated research responses.
- Researcher sign-in allows 10 failed attempts per client per 15 minutes, and 200 across all clients per hour, on both standalone targets. A client is its IPv4 address, or its /64 for IPv6. Every attempt is counted before the password is compared, and a correct password is not counted.
- Over a sign-in limit, sign-in answers 429 with `Retry-After`, even for the correct password. If the attempt store (Durable Object or Redis) or `RATE_LIMIT_SALT` is unavailable, it answers 503 rather than skipping the limit.
- On Node, the sign-in client is the first address of `x-vercel-forwarded-for`, `x-forwarded-for` or `x-real-ip`, as for participant limits. On Vercel the platform sets `x-vercel-forwarded-for`. Behind a host or proxy that passes client-supplied values through, a client can choose its own address, and only the global window bounds it. That client can exhaust the window to block every sign-in for up to an hour. Put such a host behind a proxy that overwrites the header.
- On Cloudflare, rate limits use only the validated `CF-Connecting-IP`. Automatic invocation logs are disabled, because they would record participant link codes in URLs. No Redis client can be constructed inside the Worker.
- Researchers remain responsible for consent language, retention, deletion, provider terms, and applicable research/privacy governance.

Do not place real credentials in issues, logs, screenshots, chat transcripts or diagnostic output.

## Contribute

Contributing or working with a coding agent? Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and the repository map in [`AGENTS.md`](AGENTS.md). The [development guide](docs/development.md) lists the verification commands, test lanes and release steps.

## Documentation

For researchers:

- [Research guide](docs/research-guide.md): the demo and sample study, running a study, interviewer control and question craft, provider disclosure, languages, voice input, revisions, Explore, exports, projects and researcher AI request limits

For people running an instance:

- [Self-host on Cloudflare](docs/self-hosting-cloudflare.md): requirements, plan choice, install, credentials, jurisdiction and updates
- [Self-host on Node or Vercel](docs/self-hosting-node.md): requirements, local setup, production variables, transports, Vercel deploy and setup diagnostics
- [Hosted researcher accounts](docs/operations/hosted.md): researcher journey, operator requirements, migrating pre-opaque-link deployments and the future hosted cutover runbook
- [Cloudflare installer guide](docs/operations/cloudflare-migration/INSTALLER.md) and [operator runbook](docs/operations/cloudflare-migration/RUNBOOK.md): every installer command, maintenance modes, backup/import, restore and rollback
- [Node/Vercel to Cloudflare transition runbook](docs/operations/cloudflare-migration/TRANSITION.md)
- [Cloudflare design record](docs/operations/cloudflare-migration/IMPLEMENTATION.md) and [September 30 release status](docs/operations/cloudflare-migration/evidence/V5-STATUS-2026-09-30.md)
- [Agent skill for installing and operating a Cloudflare instance](skills/openinterviewer-cloudflare/SKILL.md)

For contributors:

- [Development and verification](docs/development.md): checks, test lanes, live-provider smoke test, releases, provider API and model contract, and project structure
- [Contributing guide](CONTRIBUTING.md) and [agent and architecture guide](AGENTS.md)
- [Release notes](docs/releases/), latest [5.4.0](docs/releases/v5.4.0.md)
- [Translation review, October 2026](docs/translations/REVIEW-2026-10.md)

## Acknowledgments

Thank you to [@8888oukaouka-spec](https://github.com/8888oukaouka-spec) for the
[openinterviewerver02 fork](https://github.com/8888oukaouka-spec/openinterviewerver02),
its study-deletion prototype and historical-analysis change, and the research
workflow proposal that helped shape v5's evidence exploration, and for the ideas
behind interview languages, voice input, Markdown export (5.1) and projects (5.3). See
[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for the contributions and source commits.

## License

MIT
