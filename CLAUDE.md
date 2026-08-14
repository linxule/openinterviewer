# OpenInterviewer

## Stack
- Next.js 16 App Router, React 19, TypeScript, Tailwind CSS (stone palette), Framer Motion
- `@upstash/redis` for KV storage (not `@vercel/kv` — supports dynamic client URLs)
- `jose` for JWT signing/verification, `arctic` v3 for OAuth
- `npm` for package management (`package-lock.json` is authoritative)

## Architecture
- Dual deployment: `DEPLOYMENT_MODE` must be exactly `standalone` or `hosted`. Unset defaults to standalone only outside production; production misconfiguration fails closed.
- `src/lib/mode.ts` — `resolveDeploymentMode()` / `isStandaloneMode()` / `isHostedMode()` helpers
- `src/lib/hostedConfig.ts` — server-only hosted readiness validator; public DTO is booleans + error identifiers
- `src/lib/appBaseUrl.ts` — canonical `APP_BASE_URL`; localhost fallback only in non-production
- `src/lib/researcherContext.ts` — central per-request context resolution
  - `getRequestContext()` for admin/researcher routes
  - `getParticipantRequestContext(request)` for participant routes
- All KV functions in `src/lib/kv.ts` accept optional `client?: Redis` parameter
- `src/lib/kvClient.ts` — dynamic Redis client factory with LRU cache; exports `isValidUpstashUrl()` for SSRF prevention
- `src/lib/platformDb.ts` — platform DB for researcher accounts (hosted mode only); supports `PLATFORM_KEY_PREFIX` env var for staging/prod isolation
- AI providers: in hosted mode, pass `''` to prevent env var fallback; `undefined` allows it
- `src/lib/crypto.ts` — versioned AES-256-GCM credential envelopes bound to researcher and field purpose

## Gotchas
- TypeScript target does NOT support `downlevelIteration` — cannot spread `Map.entries()` or use `for...of` on Maps. Use `forEach` instead.
- Session and participant JWTs use independent secrets (`SESSION_SECRET`, `PARTICIPANT_TOKEN_SECRET`) and never fall back to `ADMIN_PASSWORD`. Always check `payload.type` to prevent token-type confusion. Middleware must verify the same HS256 issuer/audience/type/hosted `researcherId` contract as `src/lib/auth.ts`.
- `null ?? getKVClient()` calls `getKVClient()` because `??` coalesces null. This matters in the KV client resolution pattern.
- Standalone mode must work with zero hosted-mode env vars. Guard hosted-only code paths with `isHostedMode()`.
- User-provided URLs used server-side must be validated (SSRF). Only `https://*.upstash.io` allowed for Redis.
- Security-sensitive checks (e.g., "links disabled") should fail closed — deny on error, not allow.
- Gemini API key validation uses `x-goog-api-key` header, not query string (avoids log leakage).

## Testing
- `npm run check` runs lint, typecheck, and the Vitest suite
- `npm run test:setup` verifies the redacted environment checker
- `npm run test:e2e` runs the deterministic public-demo browser regression
- Production builds must pass in both `DEPLOYMENT_MODE=standalone` and `DEPLOYMENT_MODE=hosted`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
