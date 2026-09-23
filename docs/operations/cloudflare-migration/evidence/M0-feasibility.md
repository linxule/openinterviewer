# M0 — runtime feasibility evidence

Recorded 23 September 2026 on branch `feat/cloudflare-standalone` (base `35f90c7`). Local runtime only: no Cloudflare account, credentials, provider or remote binding was used. These results establish local workerd behavior; they do not establish production storage durability, real ingress headers or Queue scheduling after inactivity (see 04 — remote gates).

## Pinned toolchain

| Component | Version | Notes |
| --- | --- | --- |
| Node / npm | 26.9.0 / 11.19.1 | `engines` requires ≥ 24.19.0 |
| Next / React | 16.3.4 / 19.3.0 | unchanged from lockfile |
| `@opennextjs/cloudflare` | 1.20.6 (exact) | peer `next >=16.3.3`, `wrangler ^4.125.0` |
| `wrangler` | 4.136.3 (exact) | bundles miniflare 5.20260921.0-alpha, workerd 1.20260921.1 |
| `@cloudflare/vitest-pool-workers` | 0.22.0 (exact, latest) | pins its own wrangler 4.124.0 / miniflare 5.20260815.0-alpha / workerd 1.20260815.1 |
| `compatibility_date` | `2026-08-15` | the newest date both pinned runtimes support |
| `compatibility_flags` | `nodejs_compat`, `global_fetch_strictly_public` | |

Adding the three dev dependencies changed two unrelated transitive versions (`side-channel` 1.1.0 → 1.1.1, `side-channel-list` 1.0.0 → 1.0.1); `npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities.

## Artifact

`DEPLOYMENT_MODE=standalone opennextjs-cloudflare build` succeeds in ~17 s. `wrangler deploy --dry-run` reports **Total Upload 18,848 KiB / gzip 3,986 KiB** for the unmodified application. This exceeds the Workers Free 3 MiB compressed limit and fits the Paid 10 MiB limit: Cloudflare installations require Workers Paid. The build warns that Node.js middleware (`src/proxy.ts`) is experimental in OpenNext; the checks below exercise it in the artifact. `.open-next/cloudflare/next-env.mjs` is empty: OpenNext inlines Next `.env*` values into the Worker at build time, so the Cloudflare build must refuse to run with local `.env*` files present.

## Observations in local workerd (`wrangler dev --local`)

| Probe | Result |
| --- | --- |
| Public pages `/`, `/demo`, `/self-host`, `/login` | 200 |
| Protected `/dashboard`, `/studies` without cookie | 307 → `/login?redirect=…` (proxy runs) |
| Invalid `research-auth` cookie | 307 and cookie cleared (also emits an internal `x-middleware-set-cookie` response header) |
| `POST /api/auth` with synthetic password | 200, HS256 cookie `Secure; HttpOnly; SameSite=strict` (`NODE_ENV` is `production` in the artifact) |
| Authenticated `/dashboard`, `/api/auth/me`, `/api/studies` | 200 (studies returned the Redis "not configured" warning — expected before M1) |
| `/api/config/readiness` | 200 `ready:false` with Redis errors (expected before RT-08) |
| `process.env.SESSION_SECRET` in first fetch, **alarm and Queue handlers before any fetch** | present (populated by the platform, not only by OpenNext's first-fetch copy) |

Transaction/alarm probes (`cloudflare/probe/`), SQLite-backed DO in the same artifact as the OpenNext `fetch`:

| Cut | Observed durable state |
| --- | --- |
| `transaction(async)`: SQL insert, `await setAlarm()`, then throw | row absent, `getAlarm()` null — both rolled back |
| SQL insert, then `setAlarm(NaN)` rejects | row absent, alarm null |
| Competing deadlines (late, earlier, later) with min-deadline rule | earliest retained |
| Commit SQL+alarm, SIGKILL whole runtime before RPC reply, restart on same persistence dir with no requests | client saw socket error; after restart the row exists, the alarm fired unprompted, the alarm's Queue send was consumed |
| SIGKILL while an uncommitted transaction is stalled after SQL+`setAlarm` | after restart neither row nor alarm exists |

Reproduce: `opennextjs-cloudflare build`, then `node cloudflare/probe/crash-probe.mjs <synthetic-env-file> <fresh-dir> <port> [after-commit|inside-tx]`, and `wrangler dev --config cloudflare/probe/wrangler.probe.jsonc` for the rollback probes (`/__probe/{rollback,alarmfail,competing}`). The probe entry is never referenced by deployable configuration.

Decision: the storage/jobs specifications' `ctx.storage.transaction(async () => { SQL; await setAlarm() })` hypothesis holds in the pinned local runtime. Continue M1.
