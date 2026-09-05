# Contributing to OpenInterviewer

Thanks for improving OpenInterviewer. This application handles research consent, participant transcripts, researcher credentials, and provider-backed analysis, so small-looking changes can cross important trust boundaries.

Read [`AGENTS.md`](AGENTS.md) first for the architecture map, security invariants, and area-specific tests. Use [`README.md`](README.md) for product behavior and setup.

## Local development

Use Node 24 and npm:

```bash
npm ci
cp .env.example .env.local
# Fill the required standalone values in .env.local, then:
npm run setup:check -- --mode standalone
npm run dev
```

The keyless `/demo` needs no provider key or database. Real researcher and participant flows require the standalone variables documented in `README.md`, or a correctly configured hosted deployment.

Never commit credentials or real participant content. Use synthetic fixtures only.

## Making a change

1. Inspect `git status` and preserve unrelated work.
2. Read the implementation and the tests protecting the same boundary.
3. Keep the change narrow; avoid mixing dependency, architecture, and visual refactors without a reason.
4. Add a realistic regression for behavior changes.
5. Update documentation only when a user, operator, or code contract changed.

For visual changes, inspect the actual page at desktop and 375px. For participant, auth, storage, or provider changes, test failure and retry paths as well as success.

## Verification

Run the focused test while iterating, then the repository gate:

```bash
npm run check
npm run test:setup
DEPLOYMENT_MODE=standalone npm run build
npm run test:e2e
git diff --check
```

Changes to hosted configuration, auth, tenancy, storage, or provider resolution must also pass a hosted production build using the safe fixture environment in `.github/workflows/ci.yml`.

For completion, synthesis, persistence, or export changes, run the browser workflow suite as well as focused unit tests. Its direct and Gateway journeys connect the real API handlers, signed synthesis receipts, and disposable Redis persistence; mocking each service independently can hide incompatible contracts. Run with Docker or a local `redis-server`, and unset inherited Redis connection/attestation variables. Provider HTTP responses are synthetic, so no provider key or paid request is needed.

## Pull requests

Describe:

- the user-visible or trust-boundary outcome;
- the focused regression added;
- the full verification run;
- any migration, rollout, privacy, or operational caveat.

Do not include secrets, provider responses containing participant data, or production database output in issues, logs, screenshots, or pull requests.
