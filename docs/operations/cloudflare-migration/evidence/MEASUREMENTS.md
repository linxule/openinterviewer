# Cloudflare artifact measurements and evidence index

Recorded 23 September 2026 (times are local, +0200, unless marked UTC) on branch `feat/cloudflare-standalone`, HEAD `c60c7df` at the time of writing. Every number below comes from a command run in this pass unless it is marked otherwise. Local only: no Cloudflare account, credentials, provider call or remote binding was used. The only network traffic was fetching public pages from `developers.cloudflare.com` and wrangler's own npm update check (it printed `update available 4.137.0`).

What was measured:

- The shared artifact `dist/cloudflare/artifact`. Its `manifest.json` records source `fcac67397d04` (dirty), `builtAt` `2026-09-23T14:33:21Z`, `workerSha256` `08e104b8…`, and `lockfileSha256` `8d129794…`, which equals the current `package-lock.json`. Code changed after that build (uncommitted edits by other agents, and later commits) is not in these numbers. Repeat the size and startup sections after the next `npm run build:cloudflare`.
- The OpenNext intermediates from the same build (`.open-next/`, `.next/`, timestamps 16:33). The source map's embedded copies of `.open-next/server-functions/default/handler.mjs` and `.open-next/middleware/handler.mjs` hash-match the files on disk (SHA-256 `4ea23da8e5e3…` and `2d5fb49c31be…`).
- The M0 baseline bundle, kept at `<scratch>/m0-dist` (13:36, the unmodified application with the M0 toolchain; see `M0-feasibility.md`).

Machine: Apple M4 Max, Darwin arm64. Node 26.9.0 and npm 11.19.1. The artifact was also built with Node 26.9.0 (`manifest.toolchain.node`). The repository pins 24.19.0 (`.nvmrc`, `.node-version`, and CI `node-version`), so artifact bytes under 24.19.0 are unverified.

`<scratch>` means `/private/tmp/claude-501/-Users-xulelin-Documents-Apps-openinterviewer/15218b47-ddfa-4115-9cc2-5e13c335d375/scratchpad`. It holds this pass's logs, dry-run configurations, CPU profiles and the M0 baseline, none of which are committed.

The measurement scripts are committed in `scripts/cloudflare/measure/`. Each has a usage comment. They run from the repository root, or any directory, with repository-relative defaults: the artifact, `.open-next/` and `.next/` of the last build. Unless given paths, they write to `dist/cloudflare/measure/`, which is ignored.

| Script | Purpose | Run with defaults |
| --- | --- | --- |
| `attribute.mjs` | Decodes `worker.js.map` (VLQ) and sums generated `worker.js` bytes per source. Bytes that map into the two OpenNext handlers are then assigned to the esbuild module wrapper that contains them. | `node scripts/cloudflare/measure/attribute.mjs` |
| `compose.mjs` | Splits each Turbopack chunk by package using the chunk's own `.next/server/chunks/*.js.map`, scaled to the `worker.js` bytes of that chunk. Reads `attribute.mjs` output. | `node scripts/cloudflare/measure/compose.mjs` |
| `turbopack.mjs` | Parses every Turbopack server chunk bundled into the handler with acorn. It reports module ids that appear in more than one chunk, identical chunk groups, and which routes load which chunk. | `node scripts/cloudflare/measure/turbopack.mjs` |
| `turbo-ident.mjs` | Identifies duplicated module ids exactly, using the chunk source maps. Reads `turbopack.mjs` output. | `node scripts/cloudflare/measure/turbo-ident.mjs` |
| `profile.mjs` | Aggregates `wrangler check startup` CPU profiles by original source. | `node scripts/cloudflare/measure/profile.mjs <profile.cpuprofile>...` (defaults to every `*.cpuprofile` in `dist/cloudflare/measure/`) |
| `openrouter-retry.mjs` | Credential-free control for the OpenRouter SDK's default retry timing, optionally with the fixture's `retry-after-ms` header. | `node scripts/cloudflare/measure/openrouter-retry.mjs 40 [--retry-after-ms 1]` |
| `lazy-sdk.mjs` | Checks that the Queue consumer graph evaluates no provider SDK when it loads (R2). Added after this measurement. | `node scripts/cloudflare/measure/lazy-sdk.mjs [repo root]` |
| `lib.mjs` | Shared defaults and paths for the scripts above. | (imported only) |

The committed copies were checked against the same artifact at 17:30. Nothing else was re-measured. `attribute.mjs`, `compose.mjs`, `turbopack.mjs`, `turbo-ident.mjs` (15 rows, the new default) and `profile.mjs` (over `<scratch>/measure/dry/startup-*.cpuprofile`) reproduced the outputs recorded below exactly. JSON files were identical under `JSON.stringify`, and text output matched with `diff`. The only differences were the output path and the `worker` field. The all-defaults sequence `attribute.mjs`, `compose.mjs`, `turbopack.mjs`, `turbo-ident.mjs` exited 0 from the repository root.

## 1. Pinned toolchain

Commands: a `node -e` scan of `package-lock.json` for every instance of each package, `node_modules/<pkg>/package.json` versions, `wrangler --version` (`4.136.3`), `workerd --version` (`workerd 2026-09-21`), and `manifest.json` `toolchain`.

| Component | Lockfile (single instance unless noted) | `package.json` range | Notes |
| --- | --- | --- | --- |
| Node / npm | 26.9.0 / 11.19.1 (local) | `engines` `>=24.19.0` | Pinned 24.19.0 in `.nvmrc`, `.node-version` and CI |
| `next` | 16.3.4 | `^16.3.4` | `react` and `react-dom` 19.3.0 |
| `@opennextjs/cloudflare` | 1.20.6 | `1.20.6` exact | Peers `next >=16.3.3`, `wrangler ^4.125.0` |
| `@opennextjs/aws` | 4.1.4 | exact dependency of the above | Nested `esbuild` 0.25.4 (`node_modules/@opennextjs/aws/node_modules/esbuild`) |
| `wrangler` | 4.136.3 | `4.136.3` exact | Depends on `esbuild` 0.28.1, `miniflare` 5.20260921.0-alpha, `workerd` 1.20260921.1, `unenv` 2.0.0-rc.24, `@cloudflare/unenv-preset` 2.16.2 |
| `workerd` | 1.20260921.1 | via wrangler | `@cloudflare/workerd-darwin-arm64` 1.20260921.1 |
| `miniflare` | 5.20260921.0-alpha | via wrangler | |
| `@cloudflare/vitest-plugin` | 1.2.3 | `1.2.3` exact | Exact dependencies `wrangler` 4.136.3, `miniflare` 5.20260921.0-alpha, `esbuild` 0.28.1: the same runtime as production |
| `vitest` | 4.1.11 | `^4.1.10` | |
| `@anthropic-ai/sdk` | 0.125.0 | `^0.125.0` | |
| `openai` | 7.15.0 | `^7.15.0` | |
| `@google/genai` | 2.22.0 | `^2.22.0` | |
| `@openrouter/sdk` | 1.2.117 | `1.2.117` exact | Peer `zod ^3.25.0 \|\| ^4.0.0`; `zod` 4.4.3 installed |
| `ai` (Gateway path, Node only) | 7.0.99 | `^7.0.99` | Present in the Cloudflare server handler; see section 3 |
| Compatibility date | `2026-09-15` | `wrangler.jsonc:14` | The test configuration `cloudflare/test/wrangler.test.jsonc:8` uses the same date |
| Compatibility flags | `nodejs_compat`, `global_fetch_strictly_public` | `wrangler.jsonc:15` | The test configuration (`:9`) sets only `nodejs_compat` |

## 2. Artifact size

### What wrangler reports

| Source | Output |
| --- | --- |
| `npm run build:cloudflare` log (`<scratch>/build.log`, 16:33, `wrangler deploy --dry-run --outdir`) | `Total Upload: 26761.19 KiB / gzip: 5386.59 KiB` |
| Deploy-path dry run (this pass) | `Total Upload: 26761.19 KiB / gzip: 5387.01 KiB`. Attaches 2 additional modules: `resvg.wasm` 1346.05 KiB and `yoga.wasm` 70.05 KiB |
| `wrangler check startup` (this pass, section 4) | `Bundle: 26761.19 KiB / gzip: 5386.17 KiB` |

The deploy-path dry run used the same derivation as `scripts/cloudflare/deploy.mjs:116-124` (`no_bundle`, `find_additional_modules`, a `CompiledWasm` rule, and the artifact's `worker/` as `base_dir`), with synthetic installation variables. Command: `env -i PATH=… HOME=<scratch>/measure/dry/home WRANGLER_SEND_METRICS=false OPEN_NEXT_DEPLOY=true node_modules/.bin/wrangler deploy --config <scratch>/measure/dry/derived.json --dry-run --outdir <scratch>/measure/dry/out --experimental-provision=false --experimental-auto-create=false --strict`. Exit code 0. The `worker.js` in the outdir is byte-identical to the artifact's (`cmp`).

Arithmetic check: `worker.js` 25,953,368 + `resvg.wasm` 1,378,357 + `yoga.wasm` 71,736 = 27,403,461 bytes = 26,761.19 KiB (26.13 MiB). Wrangler's gzip figure is `zlib.gzipSync` over the concatenated modules (`node_modules/wrangler/wrangler-dist/cli.js`, `getSize`). The same computation in Node gives 5,386.17 KiB. The sub-KiB differences between the three runs come from module order.

### Per-file sizes (`dist/cloudflare/artifact/worker`)

Command: `stat -f "%z"` and `gzip -9 -c <file> | wc -c`.

| File | Bytes | gzip -9 | Uploaded |
| --- | --- | --- | --- |
| `worker.js` | 25,953,368 | 4,910,268 | yes (main module) |
| `77d9faeb…-resvg.wasm` | 1,378,357 | 527,032 | yes (CompiledWasm) |
| `a5d4d0ae…-yoga.wasm` | 71,736 | 28,571 | yes (CompiledWasm) |
| `worker.js.map` | 41,663,444 | 7,737,317 | **no** |
| `README.md` | 116 | not measured | no |
| Directory total | 69,067,021 | | |

The directory total equals `manifest.artifact.workerBytes`. The build log of this artifact printed `worker 65.9 MiB`, which is this on-disk total including the source map. It is not the upload size, although it reads like one and is above 64 MiB. `scripts/cloudflare/build.mjs` now prints the uploaded modules and the map separately. Evaluated against this artifact, the new label code prints `worker modules 26.13 MiB in 3 files, source map 39.73 MiB not uploaded`. It counts every file except `*.map` and wrangler's `README.md`, and 27,403,461 B is wrangler's Total Upload. `manifest.artifact.workerBytes` is unchanged and still includes the map. Static assets are uploaded separately and do not count toward the Worker size: 60 files, 1,660,330 bytes, largest 229,156 bytes.

### Cloudflare limits

Fetched on 23 September 2026 at 14:46 UTC as `index.md`:

| Limit | Workers Free | Workers Paid | Source |
| --- | --- | --- | --- |
| Worker size (uncompressed) | 64 MiB | 64 MiB | <https://developers.cloudflare.com/workers/platform/limits/#worker-size> (page "Last updated Sep 5, 2026"): "There is no compressed size limit. Only the uncompressed bundle size counts." |
| Compressed size | removed (was 3 MB) | removed (was 10 MB) | <https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/> |
| Worker startup time | 1 second | 1 second | limits page, `#worker-startup-time` |
| CPU time per HTTP request | 10 ms | 5 min (default 30 s) | limits page, `#cpu-time` |
| Memory per isolate | 128 MB | 128 MB | limits page, `#memory` |
| Source map size | 15 MB gzipped | 15 MB gzipped | <https://developers.cloudflare.com/workers/observability/source-maps/> |

Wrangler 4.136.3 uses the same bound: `MAX_UNCOMPRESSED_SIZE_BYTES = 64 * 1024 * 1024` in `bundle-reporter.ts`. The artifact uses 27,403,461 / 67,108,864 = 40.8% of the size limit, leaving 39,705,403 bytes of headroom. Size therefore does not force a plan. Whether the Free plan's 10 ms CPU limit fits is a remote gate (section 6).

### Source maps

- `upload_source_maps` is not set in `wrangler.jsonc`. `deploy.mjs` derives the upload configuration from the template plus the installation file. `configDrift` (`deploy.mjs:41-51`) refuses any key outside `INSTALLATION_OWNED`, so an installation cannot turn source maps on.
- Wrangler attaches source maps only when `upload_source_maps` is true: `sourceMaps: uploadSourceMaps ? loadSourceMaps(...) : void 0` in `wrangler-dist/cli.js`. The deploy-path dry-run outdir contains `worker.js`, the two `.wasm` files and `README.md`, and no map. Total Upload equals the three module sizes. The 41.66 MB (40,686.96 KiB) map is therefore **not uploaded**.
- If source maps were enabled, the map compresses to 7.74 MB with gzip -9, under the 15 MB gzipped limit. The pages above do not say whether an uploaded map counts toward the 64 MiB limit. Wrangler's own `getSize` counts modules only.

## 3. Bundle composition

### Method

1. **Level 1 (exact).** `node scripts/cloudflare/measure/attribute.mjs` (its defaults are `dist/cloudflare/artifact/worker/worker.js`, its map and `.open-next/server-functions/default/handler.mjs.meta.json`). Each generated byte range between two mapping segments is assigned to the segment's source. The attributed plus unmapped bytes equal 25,953,368 exactly. The map has 1,479 sources and 479,221 unmapped bytes.
2. **Level 2 (exact).** Bytes that map into the server handler are assigned to the esbuild `__commonJS`/`__esm` wrapper key (`{"<input path>"(`) that contains them, bounded by `bytesInOutput` from OpenNext's esbuild metafile. The handler has 671 wrapper keys; 42,076 bytes fall outside any wrapper. The Node middleware is not minified, so its `// <path>` module comments mark the regions instead: 102 regions, with 4,486 bytes outside any.
3. **Level 3 (scaled).** Each Turbopack chunk is split by package using its own source map from `.next/server/chunks`. That split is exact within the chunk file, then scaled to the `worker.js` bytes of the chunk (`compose.mjs`). The scaling is the only approximation.

### Where the bytes are

| Layer | Loaded | `worker.js` bytes | Share |
| --- | --- | --- | --- |
| OpenNext server handler (`.open-next/server-functions/default/handler.mjs`) | On the first request (`await import(...)`, `.open-next/worker.js:39`) | 18,915,885 | 72.9% |
| Node middleware (`.open-next/middleware/handler.mjs`) | At startup (static import, `.open-next/worker.js:8`) | 3,014,172 | 11.6% |
| Worker graph (`cloudflare/worker.ts`, WorkspaceStore, Queue consumer, provider SDKs), including 479,221 unmapped bytes | At startup in the measured build (static imports, `cloudflare/worker.ts:13,20`; `cloudflare/analysis/execute.ts:7-10` then). Provider SDKs now load on first use, see R2 | 4,023,311 | 15.5% |

Formatting accounts for much of the size. The server handler is 13,009,840 bytes on disk because OpenNext minifies whitespace and syntax but not identifiers (`@opennextjs/cloudflare/dist/cli/build/bundle-server.js:69-71`). It occupies 18,915,885 bytes (×1.45) in `worker.js` because wrangler re-bundles without minification, and `wrangler.jsonc` sets no `minify`. `worker.js` has 453,348 lines, 4,090,126 bytes of leading indentation, 453,347 newline bytes and 36,736 keep-names `__name(` calls. The 479,221 unmapped bytes are esbuild output: the helper prologue, `__name(...)` statements, preserved `/** */` comments and the export block. They are spread over 3,450 runs of lines with no mapping.

### Top 25 contributors

Package level, all layers. Columns 5 to 7 split the total by layer. Handler rows that come from Turbopack chunks are scaled (level 3). `next` is `node_modules/next` outside `dist/compiled`, and `next (compiled X)` is `next/dist/compiled/X`.

| # | Contributor | `worker.js` bytes | Share | Worker graph | Server handler | Middleware |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | next | 4,950,439 | 19.1% | 0 | 4,601,515 | 348,924 |
| 2 | next (compiled next-server) | 2,921,821 | 11.3% | 0 | 1,741,310 | 1,180,511 |
| 3 | @openrouter/sdk | 2,774,718 | 10.7% | 1,186,249 | 1,588,469 | 0 |
| 4 | @google/genai | 1,866,431 | 7.2% | 803,473 | 1,062,958 | 0 |
| 5 | app: src/lib | 1,562,707 | 6.0% | 86,963 | 1,473,549 | 2,194 |
| 6 | openai | 1,355,855 | 5.2% | 564,108 | 791,747 | 0 |
| 7 | @upstash/redis | 1,183,360 | 4.6% | 0 | 1,183,360 | 0 |
| 8 | next (compiled @vercel/og) | 824,235 | 3.2% | 0 | 0 | 824,235 |
| 9 | zod | 759,855 | 2.9% | 303,872 | 455,983 | 0 |
| 10 | @anthropic-ai/sdk | 690,788 | 2.7% | 328,783 | 362,005 | 0 |
| 11 | (Turbopack runtime glue, unmapped in chunk maps) | 683,146 | 2.6% | 0 | 671,903 | 11,243 |
| 12 | next (compiled @opentelemetry/api) | 629,459 | 2.4% | 0 | 490,847 | 138,612 |
| 13 | next (compiled jsonwebtoken) | 502,251 | 1.9% | 0 | 234,616 | 267,635 |
| 14 | (unmapped `worker.js` bytes, esbuild glue) | 479,221 | 1.8% | 479,221 | 0 | 0 |
| 15 | app: src/components | 352,689 | 1.4% | 0 | 352,689 | 0 |
| 16 | next (compiled ua-parser-js) | 335,715 | 1.3% | 0 | 309,523 | 26,192 |
| 17 | react-dom | 284,678 | 1.1% | 0 | 284,678 | 0 |
| 18 | ai | 284,573 | 1.1% | 0 | 284,573 | 0 |
| 19 | google-auth-library | 281,625 | 1.1% | 0 | 281,625 | 0 |
| 20 | app: src/app | 218,098 | 0.8% | 0 | 218,098 | 0 |
| 21 | web-streams-polyfill | 201,424 | 0.8% | 0 | 201,424 | 0 |
| 22 | @opennextjs/aws | 182,589 | 0.7% | 0 | 79,448 | 103,141 |
| 23 | app: cloudflare/workspace | 173,090 | 0.7% | 173,090 | 0 | 0 |
| 24 | @ai-sdk/gateway | 169,436 | 0.7% | 0 | 169,436 | 0 |
| 25 | ws | 139,547 | 0.5% | 0 | 139,547 | 0 |

The Worker graph totals 4,023,311 bytes: provider SDKs plus `zod` 3,186,485 (`@openrouter/sdk` 1,186,249, `@google/genai` web build 803,473, `openai` 564,108, `@anthropic-ai/sdk` 328,783, `zod` 303,872), application code 274,174, unmapped glue 479,221, and OpenNext glue and small dependencies 83,431. `@openrouter/sdk` is the only Worker-graph package that imports `zod`: 706 of its source files do, per the source map's `sourcesContent`.

### Modules that appear more than once

**Byte-identical Turbopack chunks.** Next emits the same chunk content under several names, and OpenNext bundles every copy. Contents were compared by SHA-256 after removing the trailing `//# sourceMappingURL` comment, which is the only difference; for example, `cmp` shows 6 differing bytes out of 1,786,131 for the twin pair. The routes come from each `route.js`'s `R.c("server/chunks/…")` calls.

| Copies | Example chunk | File bytes each | `worker.js` bytes per copy | Excess `worker.js` bytes | Contents (exact, via chunk maps) | Loaded by |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | `[root-of-the-server]__0txo9z4._.js` (+8) | 254,641 | 426,853–426,965 | 3,414,982 | Next server internals (module ids 74017, 17413, 68665, 99299, 2491, 91401), `@upstash/redis` (id 3096, 70,977 B) | One copy per route group, 40 routes in all. 14 routes: account ×3, `auth/me`, `config/status`, `demo/seed`, `generate-link`, onboarding ×4, `studies/[id]/aggregate`, `studies/[id]/participant-links`, `studies/reconcile`. 2 OAuth callbacks. 2 OAuth starts. `auth`. `config/mode`, `config/readiness` and `health/ready`. `consent`. 5 provider routes. 7 interview/study routes. 5 operator routes. |
| 2 | `[root-of-the-server]__0qijwns._.js` / `__0n5xmx0._.js` (1,786,131 B, 1.70 MiB) | 1,786,131 | 2,658,893 | 2,658,893 | id 16011 (1,181,012 B: `@openrouter/sdk` 533,533, `openai` 265,298, `zod` 154,180, `ai` 95,777, `@ai-sdk/gateway` 57,913, `@ai-sdk/provider-utils` 43,516); id 34731 (362,288 B: `@google/genai` Node build 357,025); the chunk also carries `google-auth-library` 10.5.0 and `gaxios` 7.1.3 (their `package.json` literals) | `0qijwns`: generate-link, greeting, interview, interviews/[id]/analyze, studies/[id]/generate-followup, studies/[id], studies, synthesis/aggregate, synthesis. `0n5xmx0`: interviews/save only |
| 5 | `src_lib_1e2amg6._.js` (+4) | 86,181 | 108,478 | 433,832 | `src/lib/platformDb.accountDelete.ts`, `platformDb.ts` (id 89572), `platformDb.operations.ts` (id 1277) | API routes |
| 4 | `src_lib_19u7i94._.js` (+3) | 82,953 | 108,886 | 326,584 | `src/lib/kv.ts` + `studyJsonLua.ts` (id 66555), `participantLinks.ts` (id 50089) | API routes |
| 2 | `[root-of-the-server]__091oki0._.js` | 65,139 | 113,945 | 113,945 | `web-streams-polyfill` (id 8543) | Loaded from other chunks (async chunk loading), not by a route entry |
| 4 | `src_lib_1gsso4g._.js` (+3) | 25,088 | 33,491 | 100,435 | not identified beyond `src/lib` | API routes |
| 10 | `[root-of-the-server]__187tk9k._.js` (+9) | 596 | 948 | 8,450 | small | Loaded from other chunks and the Turbopack runtime, not by a route entry |
| **Total** | | | | **7,057,121** (6,891.7 KiB, 27.2% of `worker.js`) | | |

In the OpenNext-minified handler, before wrangler re-formats it, the same duplicate copies are 4,817,437 bytes. The twin 1.70 MiB chunks already existed at M0 under the same names and sizes (2,658,094 `worker.js` bytes each then), so they are not growth. Two further 2-copy groups (`__0u3d457`, `__1v745u1`; 1.9 KB and 1.3 KB) share module ids but differ in bytes and are excluded.

**Module ids repeated across chunks** (`turbopack.mjs`, `turbo-ident.mjs`). The 235 Turbopack server chunks in the handler hold 1,023 module ids and 9,787,419 bytes of module factories, of which 4,837,045 bytes are unique. 293 ids appear in more than one chunk. The excess is 4,950,374 bytes (50.6% of Turbopack module bytes, in minified chunk-file form). The largest:

| Module id | Size (B) | Copies | Excess (B) | Contents (exact) |
| --- | --- | --- | --- | --- |
| 16011 | 1,181,012 | 2 | 1,181,012 | `@openrouter/sdk`, `openai`, `zod`, `ai`, `@ai-sdk/gateway`, `@ai-sdk/provider-utils` (one module id spanning several packages) |
| 3096 | 70,977 | 9 | 567,816 | `@upstash/redis` |
| 74017 | 52,630 | 9 | 421,040 | `next` |
| 34731 | 362,288 | 2 | 362,288 | `@google/genai` (Node build), `src/lib/prompts` |
| 17413 | 24,194 | 9 | 193,552 | `next` |
| 89572 | 38,150 | 5 | 152,600 | `src/lib/platformDb.accountDelete.ts`, `src/lib/platformDb.ts` |
| 68665 | 18,379 | 9 | 147,032 | `next` |
| 66555 | 45,634 | 4 | 136,902 | `src/lib/kv.ts`, `src/lib/studyJsonLua.ts` |
| 99299 | 16,871 | 9 | 134,968 | `next` |
| 1277 | 27,594 | 5 | 110,376 | `src/lib/platformDb.operations.ts` |
| 54614 | 8,467 | 12 | 93,137 | `src/lib/hostedConfig.ts`, `src/lib/appBaseUrl.ts` |
| 2491 | 10,825 | 9 | 86,600 | `next` |
| 8543 | 57,531 | 2 | 57,531 | `web-streams-polyfill` |
| 91401 | 6,554 | 9 | 52,432 | `next` |
| 50089 | 16,972 | 4 | 50,916 | `src/lib/participantLinks.ts` |

Much of the duplicated code is Node-target or hosted-mode code that the Cloudflare target never runs: Redis (`@upstash/redis`, `kv.ts`, `studyJsonLua.ts`), the hosted platform database (`platformDb*.ts`, `hostedConfig.ts`) and the AI Gateway path (`ai`, `@ai-sdk/gateway`, `@vercel/oidc`).

**Across layers:**

- Each provider SDK is present three times in `worker.js`: once in the Worker graph (analysis consumer) and once in each of the handler's twin chunks. `@google/genai` appears in two different builds: the web build in the Worker graph and the Node build, with `google-auth-library` 281,625 B and `gaxios` 46,648 B, in the handler. The table rows above show the per-layer split.
- The Next runtime is in both the handler and the middleware. `next/dist/compiled/next-server` (the App Router page runtime) takes 1,741,310 B in the handler and 1,180,511 B in the middleware, and compiled `jsonwebtoken` takes 234,616 B and 267,635 B.
- The middleware contains two copies of `@opentelemetry/api`, from `.open-next/middleware/node_modules/next/dist/compiled/@opentelemetry/api/index.js` (50,618 B) and `node_modules/next/dist/compiled/@opentelemetry/api/index.js` (50,595 B).
- The middleware bundles `@vercel/og` (824,235 B) and its `resvg.wasm` and `yoga.wasm` modules (1,450,093 B), although `src/` does not import `next/og` or `ImageResponse` (`grep -rn "next/og\|ImageResponse\|@vercel/og" src` found nothing). OpenNext aliases `@vercel/og` to a throwing shim only in the server bundle when it is unused (`bundle-server.js:105-113`). The Node middleware bundler (`bundle-node-middleware.js:192-195`) aliases only `@opentelemetry/api`.

**Worker graph (level 1).** No package is reached through two `node_modules` paths. Two source files have identical contents in `@anthropic-ai/sdk` and `openai` (`src/internal/utils/query.ts` and `uuid.ts`).

### Growth from 18.8–18.9 MiB to 26.1 MiB

| Point | Total Upload | `worker.js` bytes | Worker graph | Server handler | Middleware | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| M0 (13:36) | 18,848.32 KiB | 17,850,582 | 47,192 | 14,791,536 | 3,011,854 | `<scratch>/m0-dryrun.log`, `<scratch>/m0-dist/worker.js.map` |
| Dry run at 14:20:33 | 18,879.42 KiB | 17,882,437 | not measured (no map kept) | | | `<scratch>/install/dry.log`, `<scratch>/install/out/worker.js` |
| Now (16:33 build) | 26,761.19 KiB | 25,953,368 | 4,023,311 | 18,915,885 | 3,014,172 | this document |

The wasm modules (1,450,093 B) are unchanged throughout. The earlier note that the artifact was "18,879 KiB at `6a350f2`" is not supported by timestamps. The 18,879.42 KiB dry run was written at 14:20:33, before commit `24cdeb9` (14:21:02) and `6a350f2` (15:29:20). Its revision is not recorded. Its `worker.js` has 13 `// cloudflare/workspace/` module markers and **no** provider-SDK markers (`grep -c '^// node_modules/@openrouter/'` gives 0, compared with 938 now).

The M0 to now change is +8,102,786 bytes (+7,912.88 KiB), all in `worker.js`:

1. **Worker graph: +3,976,119 bytes.** `cloudflare/worker.ts` statically imports the Queue consumer (`:20`), and in the measured build `cloudflare/analysis/execute.ts:7-10` statically imported all four provider adapters (changed afterwards, R2). That pulls the SDKs into the eagerly evaluated Worker graph, adding 3,186,485 bytes of provider SDKs and `zod`. The rest is new application code (`cloudflare/workspace/*`, `cloudflare/analysis/*`, `src/lib/*`, +274,062), esbuild glue (unmapped, +474,519) and small dependencies and OpenNext glue (+41,053).
2. **Server handler: +4,124,349 bytes.**
   - Turbopack `[root-of-the-server]` chunks grew from 46 files and 6,673,634 bytes to 61 files and 10,426,947 bytes (+3,753,313). At M0, one `[root-of-the-server]` chunk (`__01n4a6u`, 273,015 B) was referenced by all 35 route entries; it no longer exists. Now nine byte-identical 254,641-byte chunks (426.9 KB each in `worker.js`, 3,841,947 B in total) are each referenced by one route group, together covering all 40 route entries. Whether these chunks hold the same modules as `__01n4a6u` was not checked, because there is no M0 `.next` output.
   - `src_lib_*` chunks grew from 15 files and 982,402 B to 20 files and 1,216,862 B (+234,460). Other server chunks went from 70 to 77 files and −72,206 B. SSR chunks went from 77 to 79 files and +177,818 B. Route entries grew from 35 to 40 `route.js` files (+6,627). The OpenNext config grew +2,979, and wrapper glue +23,951.
   - Route-entry chunk references rose from 494 (156 distinct chunks) to 535 (183 distinct chunks).
   - The map shows what moved, not why Turbopack now splits the shared set per route group.
3. **Middleware: +2,318 bytes.**

### Reduction options

Savings are from the measurements above; estimates are marked. All of these require `npm run build:cloudflare` followed by the artifact and Cloudflare browser lanes. R2 is implemented in the source after this measurement (status below). The others are not implemented.

| # | Option | Saving | Risk and notes |
| --- | --- | --- | --- |
| R1 | Minify at the wrangler bundling step: `--minify` on `build.mjs:67` or `minify: true` in the template. The deploy step uses `no_bundle`, so minification must happen at build time. | **Estimate:** `esbuild 0.28.1 --minify --keep-names --target=es2024` on the artifact's `worker.js` gives 16,517,321 B, so Total Upload would be 17,546.30 KiB (−9,214.89 KiB, −34.4%) and gzip 4,682.15 KiB. Whitespace-only minification gives 19,813.40 KiB (−26.0%). | Low. It changes formatting and local names only (wrangler keeps names). Stack traces without an uploaded map become harder to read, but the local map is still produced. |
| R2 (implemented) | Load provider adapters lazily in `cloudflare/analysis/execute.ts` (dynamic `import()` inside the queued execution path) | Startup active CPU is the target: see section 4, where about 53 ms per run of `zod` schema construction from `@openrouter/sdk`, and the garbage collection that appeared with it (37.8 ms per run, against at most 1.5 ms at M0), runs on every isolate start. Size is not unchanged: the bundler check below puts the cost at about +0.48 MB of unminified `worker.js`. | Low. Only the Queue path changes. `jobFaults`, `consumer` and `analysis` pass (section 5). |
| R3 | Collapse byte-identical Turbopack chunk copies after `next build`, for example by pointing duplicates at one canonical file, or fix this upstream | 7,057,121 `worker.js` bytes now. The same copies are 4,817,437 bytes in OpenNext's minified form, which roughly indicates the saving if R1 is also applied. | Moderate. It patches framework output. The chunk arrays contain only module ids and factories and no chunk path, which is why a re-export is plausible, but this is unverified. Report to Next and OpenNext. |
| R4 | Alias `next/dist/compiled/@vercel/og/index.edge.js` to OpenNext's throw shim in the Node middleware bundle as well | 824,235 B JavaScript + 1,450,093 B wasm = 2,274,328 B (2,221.0 KiB, 8.3% of Total Upload) | Low to moderate. It needs an OpenNext patch or an upstream fix, and `src/` must keep not using `next/og`. It also removes the two wasm modules from the upload. |
| R5 | Keep Redis, hosted-platform and AI-Gateway modules out of the Cloudflare build graph (build-time aliasing by `DEPLOYMENT_TARGET`) | Up to about 1.2 MB of `@upstash/redis` across 9 copies, `platformDb*` and `kv.ts` copies, and `ai`/`@ai-sdk/*`/`@vercel/oidc` (about 0.64 MB). This overlaps with R3. | Moderate. The Node build must stay byte-for-byte unaffected. |
| R6 | Leave `upload_source_maps` off (current) | Upload unchanged | Enabling it would upload 41.66 MB of map (7.74 MB gzip -9, under the 15 MB limit). Its effect on the 64 MiB limit is unstated. |

#### R2 status (lazy provider adapters)

`cloudflare/analysis/execute.ts` no longer imports any adapter statically. Each adapter is reached through one literal `import()` in a per-provider loader. `createQueuedSynthesisProvider` stays synchronous, so the consumer is unchanged. Before any start marker, it still refuses an unknown provider, an empty key or a model that `isKnownProviderModel` rejects, which is the check the adapter constructors apply. It returns a deferred adapter that loads and constructs the frozen provider's adapter on its first call. A load or construction failure becomes `AdapterLoadError`. `classifyProviderException` maps that to `failed/provider` with log reason `provider-failure`, never to `uncertain`, because no adapter existed and so no request was sent. The load happens on the first provider call, after the start marker, so this failure is recorded on a started attempt. The SDK retry policy, the deadline (which bounds the provider request; the lease's 20 s attach margin covers the load) and every other classification are unchanged. The import boundary still covers the adapters: esbuild follows literal dynamic imports. A scratch-copy mutant that added `import('@upstash/redis')` to the loader table made `node scripts/cloudflare/check-import-boundary.mjs` exit 1 with `✗ cloudflare/analysis/consumer.ts reaches …/@upstash/redis/nodejs.mjs (Upstash client)`.

Bundler evidence, without a new build. `node scripts/cloudflare/measure/lazy-sdk.mjs` bundles `cloudflare/analysis/consumer.ts` with esbuild 0.28.1, the version wrangler 4.136.3 bundles with. It uses the import-boundary settings plus `format: 'esm'`. It then instruments esbuild's `__esm` and `__commonJS` helpers and imports the result in Node. It exits 1 if any provider SDK module is evaluated at import. On the current tree it exited 0. Run against a scratch copy of the tree with HEAD's `execute.ts`, it exited 1:

| Consumer bundle | SDK modules in bundle | SDK modules outside lazy wrappers | SDK wrappers run at import | `zod` global registry after import | Import (Node) | Bundle bytes |
| --- | --- | --- | --- | --- | --- | --- |
| `execute.ts` from HEAD `c60c7df` (static imports), rest of the tree current | 1,283 | 1,153 | 122 | created | 104 ms | 3,899,297 |
| Current `execute.ts` | 1,308 (`@openrouter/sdk` 943, `openai` 198, `@anthropic-ai/sdk` 129, `zod` 37, `@google/genai` 1) | 0 | 0 | absent | 24 ms | 4,379,487 |

With the current code, the first queued OpenRouter call initialized exactly the `@openrouter/sdk` (943) and `zod` (37) wrappers and no other SDK. It made one fetch, which the script refuses, and took 99 ms in Node. The size cost is +480,190 B. Of that, 224,434 B is extra indentation inside the wrappers, and 255,756 B is wrapper code plus 27 modules that esbuild no longer tree-shakes out of a wrapped graph. Minification (R1) would remove the indentation and shrink the wrapper code, but this is not measured.

These are Node timings for one bundle entry, not workerd startup. The size and the `wrangler check startup` numbers in section 4 must be re-measured after the next `npm run build:cloudflare`.

## 4. Startup

`wrangler check startup --help` lists `--args` (arguments for its internal `wrangler deploy --dry-run --outfile`) and `--worker` (a prebuilt multipart bundle). Its handler (`checkStartupHandler` in `wrangler-dist/cli.js`) does not call `requireAuth`. `analyseBundle` runs the bundle in a local Miniflare instance with the inspector profiler. It therefore needs no account, and it ran.

Command, run 6 times for each bundle, all exit code 0:

```
env -i PATH=… HOME=<scratch>/measure/dry/home WRANGLER_SEND_METRICS=false OPEN_NEXT_DEPLOY=true \
  node_modules/.bin/wrangler check startup --config <scratch>/measure/dry/derived.json \
  --args="--config=<scratch>/measure/dry/derived.json --experimental-provision=false --experimental-auto-create=false" \
  --outfile <scratch>/measure/dry/startup-N.cpuprofile
```

Without `--args`, the inner `deploy --dry-run` ignores `--config` and fails with `Could not detect a directory containing static files`. The M0 baseline used a minimal configuration (`<scratch>/measure/dry-m0/m0.json`: same compatibility date and flags, no bindings) because the M0 bundle exports only `default`.

| Bundle | Active (ms, 6 runs) | Median | Mean | GC within active (ms) | Profile window (ms) | Samples |
| --- | --- | --- | --- | --- | --- | --- |
| Current artifact (26,761.19 KiB) | 105.5, 111.3, 123.3, 124.4, 118.8, 115.9 | 117.4 | 116.5 | 34.0, 33.1, 38.5, 40.8, 40.6, 39.7 | 275.0–312.7 | 79–95 |
| M0 baseline (18,848.32 KiB) | 15.1, 17.6, 17.9, 18.3, 19.2, 19.6 | 18.1 | 18.0 | 0.0–1.5 | 137.6–152.1 | 10–11 |

"Active" is wrangler's metric: sampled time minus samples attributed to `(idle)`. The idle time is the first sampling interval, 166–182 ms now and 120–134 ms at M0. What that interval contains (for example module compilation) is not established here. Wrangler's output states that local profiles do not predict startup time on Cloudflare.

Top startup costs, as mean self time per run across the 6 current profiles (`node scripts/cloudflare/measure/profile.mjs <scratch>/measure/dry/startup-*.cpuprofile`, which defaults to the artifact's map and the handler metafile; sampling interval about 1.5 ms):

| Cost | ms per run | Attribution |
| --- | --- | --- |
| Garbage collector | 37.8 | M0 has at most 1.5 |
| `zod` schema construction at module top level | 43.0 | `zod/v4/classic/schemas.js` 22.5, `v4/core/core.js` 8.1, `v4/core/schemas.js` 6.8, `util.js` 2.4, others. In the Worker graph, only `@openrouter/sdk` imports `zod`. |
| `Object.defineProperty` wrapper | 10.3 | OpenNext's middleware installs a global wrapper (`worker.js:284312`). The sampled callers are `zod`'s `defineLazy`. |
| `(program)` | 14.4 | 14.1 at M0 |
| Unmapped top-level code, including `__name` | 5.3 | |

About 99 ms of the roughly 117 ms active time is new since M0. It comes from evaluating the Worker graph's provider SDKs at isolate start, mostly `zod` schemas built by `@openrouter/sdk`. The Next server handler is not evaluated at startup (dynamic import); the middleware is. R2 (section 3) removes the SDK evaluation from isolate start in the source; these numbers predate it and must be re-measured after the next build.

### Re-measured after R2 (commit 80ec88d, artifact built from a clean tree)

`npm run build:cloudflare`: `Total Upload: 27402.67 KiB / gzip: 5439.80 KiB` (worker modules 26.76 MiB in 3 files; source map 39.96 MiB, not uploaded). R2 adds about 641 KiB of lazy-module wrappers, as section 3 predicted; 42.8% of the 64 MiB limit.

Same command as above, derived configuration generated from `wrangler.jsonc` and the manifest exactly as `scripts/cloudflare/deploy.mjs` derives it, sandboxed `HOME`, 6 runs, all exit 0:

| Bundle | Active (ms, 6 runs) | Median | Mean | GC within active (ms) |
| --- | --- | --- | --- | --- |
| 80ec88d artifact (27,402.67 KiB) | 25.1, 22.7, 23.9, 26.5, 23.9, 23.9 | 23.9 | 24.3 | 2.5–3.8 |

Local startup CPU is back within about 6 ms of M0 (18.0 ms): the provider SDKs and `zod` no longer run at isolate start. Local profiles still do not predict Cloudflare's `startup_time_ms`.

**Remote gate:** the real `startup_time_ms`, which `wrangler deploy` or `wrangler versions upload` reports according to the limits page, against the 1 s limit.

## 5. Evidence index for the review packet

### Test runs in this pass

These ran against the working tree as it was during this pass, which includes other agents' uncommitted edits, not the built artifact.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run test:cloudflare -- --reporter=verbose tests/workers/jobFaults.test.ts` | 0 | `Test Files 1 passed (1)`, `Tests 45 passed (45)`, 12.60 s |
| `npm run test:cloudflare -- --reporter=verbose tests/workers/completion.test.ts tests/workers/consumer.test.ts tests/workers/scheduler.test.ts tests/workers/analysis.test.ts` | 0 | `Test Files 4 passed (4)`, `Tests 112 passed (112)`: completion 32, consumer 19, scheduler 28, analysis 33 |
| `npm run test:redis-crash -- --reporter=verbose` | 0 | `Test Files 1 passed (1)`, `Tests 34 passed (34)` |
| `node <scratch>/measure/openrouter-retry.mjs 40` (now `scripts/cloudflare/measure/openrouter-retry.mjs`) | 0 | See the OpenRouter rows under "Gaps found while indexing" |

### Runs after the startup and evidence fixes

These ran against the working tree at about 17:30. That tree includes R2, the fixture and test changes below, and other agents' uncommitted edits. They did not use the built artifact. The mutation runs used a scratch copy of the tree with `node_modules` symlinked, deleted afterwards, so the shared checkout was never modified.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run test:cloudflare` (before the changes, baseline) | 0 | `Test Files 21 passed (21)`, `Tests 356 passed (356)` |
| `npm run test:cloudflare` | 0 | `Test Files 21 passed (21)`, `Tests 360 passed (360)` |
| `npm run test:cloudflare -- --reporter=verbose tests/workers/jobFaults.test.ts tests/workers/consumer.test.ts tests/workers/analysis.test.ts` | 0 | `Tests 101 passed (101)`: jobFaults 47, consumer 21, analysis 33. The same three files passed 5 of 5 further runs (101 each). |
| `node scripts/cloudflare/check-import-boundary.mjs` | 0 | `✓ Worker-only graph (cloudflare/analysis/consumer.ts, cloudflare/workspace/WorkspaceStore.ts) reaches no Next, Redis or hosted modules` |
| Mutant: `retries: { strategy: 'none' }` removed from `src/lib/providers/openrouter.ts:142`, then `vitest run --config vitest.workers.config.mts tests/workers/jobFaults.test.ts`, 3 runs | 1, 1, 1 | Every run: `Tests 3 failed \| 44 passed (47)`, the same three tests. The OpenRouter `500` case recorded 114, 110 and 113 requests, and the `503` case 101, 107 and 112 (`expected [ …(114) ] to have a length of 1 but got 114`). The OpenRouter control's queued call `resolved … instead of rejecting` |
| The same mutant with the old fixture header (`retry-after: 0` only), `-t "openrouter adapter"`, 5 runs | 0, 1, 0, 0, 1 | The regression went unnoticed in 3 of 5 runs. When caught, the `500` and `503` cases each showed 2 requests |
| Mutant: a static `import { OpenRouterProvider }` added to `cloudflare/analysis/execute.ts`, `-t R2` | 1 | The R2 test fails: `Caused by: Error: synthetic: ../../src/lib/providers/openrouter evaluated` |
| `node scripts/cloudflare/measure/openrouter-retry.mjs 40` | 0 | `{"trials":40,"retryAfterMs":null,"default":{"tookSecondRequest":40,"minMs":63,"medianMs":484,"maxMs":992,"within300ms":11},"strategyNone":{"maxRequests":1}}` |
| `node scripts/cloudflare/measure/openrouter-retry.mjs 40 --retry-after-ms 1` | 0 | `{"trials":40,"retryAfterMs":"1","default":{"tookSecondRequest":40,"minMs":0,"medianMs":1,"maxMs":2,"within300ms":40},"strategyNone":{"maxRequests":1}}` |

### Provider request counts under the queued zero-retry policy (JOB-09)

The fixture `installProviderFixture` (`tests/workers/jobFixtures.ts:475-527`) spies on `globalThis.fetch` inside workerd. It records every request to a provider host with its time. It refuses and records any other destination. Like `fetch`, it refuses a request whose signal is already aborted without sending it (`:481`), so a retry loop cannot outlive the caller's deadline. It serves `status` faults with `retry-after: 0` and `retry-after-ms: 1` (`:413`, `:509`). Every locked SDK honours `retry-after-ms` ahead of its own backoff: the Stainless `retryRequest` in `openai` and `@anthropic-ai/sdk`, and the Speakeasy `retryIntervalFromResponse` in `@openrouter/sdk` (`esm/lib/retries.js:129-136`) and the `@google/genai` Interactions client. An enabled SDK retry therefore reaches the fixture about 1 ms later, well inside the 300 ms test deadline. An optional `failures` count lets later requests succeed (`:398`, `:498`).

| Test | Location | Assertion |
| --- | --- | --- |
| `JOB-09 queued synthesis through the %s adapter` > `JOB-09 $name makes exactly one outbound request and settles per the classification table` | `tests/workers/jobFaults.test.ts:71-104` | `fixture.requests` has length 1 (`:81`), no unexpected destinations (`:80`), one explicit ack and no Queue retry (`:78-79`), `attempts` 1 (`:86`), and the job state matches the IMPLEMENTATION.md §5 table (`:87-103`) |
| `JOB-09 records invalid-output when OpenRouter omits the upstream provider, with one request` | `jobFaults.test.ts:108` | length 1 (`:112`) |
| `JOB-09 records invalid-output when a response omits its served model` | `jobFaults.test.ts:116` | length 1 (`:120`) |
| `JOB-09 %s retries a 500 under the default policy but not under queued-synthesis` (openai, claude, gemini, openrouter) | `jobFaults.test.ts:126-149` | Default policy: 3, 3, 5 and 3 requests (`:140`). OpenRouter's fixture recovers after two failures, because its default backoff has no retry count, only a one-hour budget. Every default-policy retry arrives within the 300 ms test deadline (`:143`). Queued: 1 (`:147`). This shows the fixture sees SDK retries, and sees them in time. |
| `R2 evaluates no adapter when the execution module loads; a failed load is a known provider failure without a request` | `jobFaults.test.ts:158` | A fresh copy of `execute.ts` loads while all four adapters are mocked to throw on evaluation. The first call fails with `AdapterLoadError`, which classifies as `failed/provider`, with 0 requests |

The matrix for `jobFaults.test.ts:71-104` has 4 adapters (openai, claude, gemini, openrouter) and 10 behaviours (`:41-60`), 40 cases in all, and all passed. Every adapter makes one request in every case. With `retry-after-ms: 1`, the `500` and `503` cases fail deterministically for any adapter whose queued call retries (see the mutant runs above). The expected settlement for each behaviour:

| Behaviour | Expected job settlement |
| --- | --- |
| success | complete, with provenance checked |
| 429 | failed/provider |
| 400 | failed/provider |
| 500 | recovery-required (`failureKind: 'timeout'`) |
| 503 | recovery-required |
| deadline timeout (hang, 300 ms deadline) | recovery-required |
| transport abort | recovery-required |
| network `TypeError` | recovery-required |
| invalid output | failed/invalid-output |
| oversized output | failed/too-large |

The per-call anchors are `src/lib/providers/openai.ts:126` and `claude.ts:123` (`maxRetries: 0`), `gemini.ts:155` (`maxRetries: 0`) and `openrouter.ts:142` (`retries: { strategy: 'none' }`).

Other request-count assertions that establish "no second paid call":

| Location | Title | Count |
| --- | --- | --- |
| `consumer.test.ts:55` | JOB-01/05 dispatches, claims, starts, calls the frozen provider once and attaches actual provenance | 1 (`:62`) |
| `consumer.test.ts:79`, `:92` | JOB-02 frozen provider, model and revision (edit before claim; change between result and attachment) | 1 |
| `consumer.test.ts:122` | JOB-02/RT-05 missing frozen provider key → failed/provider without any provider request | 0 |
| `consumer.test.ts:132` | JOB-02 frozen model no longer supported → failed/provider before the start marker (`started_at` null) | 0 (`:142`) |
| `consumer.test.ts:146` | JOB-09/R2 frozen adapter cannot be loaded → failed/provider on the started attempt, `recovery_required` 0, one ack, no Queue retry, `analysis.job` event `operation: execute`, `reason: provider-failure` | 0 (`:161`) |
| `consumer.test.ts:183`, `:194`, `:442` | Unknown message version to dead-letter; malformed or foreign envelopes; frozen maintenance | 0 |
| `consumer.test.ts:212` | JOB-06 duplicate and out-of-order deliveries without a second provider call | 1 then 1 (`:219`, `:237`) |
| `consumer.test.ts:241`, `:303` | JOB-07/08 claim or start marker cannot be confirmed → no provider call | 0 |
| `consumer.test.ts:258`, `:272` | JOB-08 lost claim reply replayed with the same nonce; a second invocation never calls | 1 |
| `consumer.test.ts:331`, `:359` | JOB-08 lost attach reply recovered from the receipt, or left to the watchdog; no second call | 1 |
| `consumer.test.ts:383` | JOB-08 started job whose invocation died → recovery-required; a late delivery never calls again | 0 after the cut |
| `consumer.test.ts:405`, `:416`, `:429` | JOB-10 deleted interview, result after deletion, old epoch | 0 / 1 / 0 |
| `scheduler.test.ts:77`, `:97` | JOB-06 identifier-only envelope; lost send acknowledgement | 0 |
| `analysis.test.ts:277` | JOB-04 the initial job's delivery races two retry keys. Each key gets `existing` or `already-complete` for generation 1, one job row exists, nothing is enqueued, and a redelivery never calls again | 1 (`:301`) |
| `analysis.test.ts:306` | JOB-04 two keys race after a terminal failure: one allocates generation 2, dispatched once. Delivering its message twice plus a late generation-1 message pays for generation 2 once | 1 (`:334`) |
| `analysis.test.ts:617` | JOB-07 late delivery after 24 h → failed/storage without a provider request | 0 (`:624`) |
| `schema.migrations.test.ts:173` | N−1 → N → N−1 → N keeps serving pending and completed jobs | 2 (`:206`) |

### Fault cuts

**Cloudflare, local workerd (`@cloudflare/vitest-plugin`, real SQLite, alarm and Queue handlers).** "Restart" in this tier is `evictDurableObject`. It tears down the object instance in the same workerd process and keeps durable storage; it is not a process kill.

| Location | Title | Cut |
| --- | --- | --- |
| `completion.test.ts:147` | ST-02: a lost-response replay returns duplicate without a second job, charge, alarm change or mutation | Committed transaction, reply lost |
| `completion.test.ts:455` | ST-04/JOB-05: a failed generation allocation rolls back every completion write and arms no alarm | Throw inside the transaction (INSERT conflict) |
| `completion.test.ts:485` | ST-04/JOB-05: a failure while registering the alarm rolls back the SQL already written | `setAlarm` injected to throw after SQL |
| `completion.test.ts:512` | ST-04/JOB-05: an object restart preserves the committed completion, its job and its wake-up | Eviction after commit; replay is `duplicate` |
| `completion.test.ts:529` | JOB-05: an earlier existing alarm is kept and a later one is pulled forward | Competing deadlines |
| `analysis.test.ts:212`, `:231`, `:248` | JOB-05 retry allocation commits with its alarm / rolls back when the alarm cannot be committed / survives an object restart before the reply | Commit+alarm; alarm failure; eviction before the reply |
| `analysis.test.ts:404`, `:430`, `:499`, `:551`, `:578`, `:631` | JOB-08 claim replay and lease rules; JOB-04/10 stale generation, job or epoch; no resurrection; 24 h pre-start cap | Late, stale and replayed RPCs |
| `scheduler.test.ts:97`, `:282`, `:342`, `:493` | Lost send ack; expired unstarted claim returns to pending under a fresh nonce; wake-up lost under an epoch mismatch restored; storage failure during the alarm persists a retry alarm | Scheduler cuts |
| `consumer.test.ts:257-402` | "response loss and crashes (JOB-08)" block: lost claim reply, failing transport, unconfirmed start, lost attach reply (two variants), invocation died after start | Reply loss and dead invocation |
| `consumer.test.ts:404-452` | "deletion and restore fences (JOB-10)" | Late messages after delete or epoch change |

**Process kill (M0 probes, toy Durable Object in the same artifact as the OpenNext fetch).** `evidence/M0-feasibility.md:39-43` (table) and `:45` (reproduction). The code is in `cloudflare/probe/crash-probe.mjs` (spawns `wrangler dev --local --persist-to`, SIGKILLs the process tree, and restarts on the same directory) and `cloudflare/probe/probe-worker.ts:41,58,84,114-118` (`rollback`, `alarmfail`, `stall-in-tx`, `competing`). Cuts: throw after SQL and `await setAlarm()`; `setAlarm(NaN)` rejection; competing deadlines; SIGKILL after commit and before the RPC reply (the row survives and the alarm fires unprompted after restart); SIGKILL during an uncommitted transaction (neither row nor alarm survives). **Not re-run in this pass.**

**Redis (`tests/integration/redis.crashCuts.test.ts`, disposable `redis-server` 8.10.2, 34 passed this pass).** Registry R1–R4 (`:173`, `:211`); authority failpoint (`:447`); create and delete W1/W2/S1–S4/D1–D4/D5 (`:479`, `:499`, `:514`, `:576`); persist F1–F5 (`:631`, `:661`); account-delete plan and cursor (`:867`); transport response loss and undecodable-after-commit (`:918`, `:928`, `:937`); analysis attach and claim fencing (`:955`, `:1008`); and `manifest coverage: every listed cut has a real-wrapper test` (`:1180`).

### Gaps found while indexing

- **Resolved: the OpenRouter zero-retry assertion was probabilistic.** OpenRouter was not in the default-policy control, which then covered openai, claude and gemini only. Its SDK default retries 5XX and connection errors with `backoff` (`node_modules/@openrouter/sdk/esm/funcs/chatSend.js:46-60`). With the fixture's `retry-after: 0`, `retryIntervalFromResponse` returns 0 and the first retry waits `Math.random() * 1000` ms (`esm/lib/retries.js:115-122`). The control run `node <scratch>/measure/openrouter-retry.mjs 40` printed `{"trials":40,"default":{"tookSecondRequest":40,"minMs":8,"medianMs":441,"maxMs":992,"within300ms":16},"strategyNone":{"maxRequests":1}}`. The network case could not help: the fixture's `TypeError('synthetic network failure')` does not match the SDK's `isConnectionError` (`esm/lib/http.js:161-175`, which matches messages starting "failed to fetch" or "fetch failed"), so it is never retried. The fixture now also sends `retry-after-ms: 1` (honoured by `retries.js:129-136`), OpenRouter is in the control, and the fixture refuses already-aborted requests. The same regression now fails 3 of 3 runs; with the old header it slipped through 3 of 5 (section 5, runs after the fixes).
- **No Cloudflare fault manifest.** VERIFY-01 (`04-verification-and-cutover.md:13`) asks for a manifest naming each cut, its durable evidence, expected reply and next action. Redis has one enforced by a test (`redis.crashCuts.test.ts:1180`). The Cloudflare tier has none; the tables above can seed one.
- **Process kill of the production `WorkspaceStore`.** Only the M0 toy object has SIGKILL-and-restart evidence. Production-class restarts use `evictDurableObject` in the same process.
- **Resolved: JOB-04 race without a provider count.** The race test asserted one active generation but did not count requests at the provider fixture, although the JOB-04 row in `03-analysis-jobs.md` names "at most one provider request". It now delivers the initial job concurrently with both retry keys and counts exactly one request (`analysis.test.ts:277`, `:301`). The terminal-failure race now pays for the winning generation 2 exactly once, despite a duplicate delivery and a late generation-1 message (`:306`, `:334`).
- The workers test configuration omits `global_fetch_strictly_public`, which production sets. The fixture replaces `globalThis.fetch`, so the flag's egress behaviour is not exercised in this tier.

## 6. Unmeasured: remote gates

- Cloudflare-side acceptance of a 26.13 MiB upload. The 64 MiB limit is established from documentation and wrangler's constant only.
- The real `startup_time_ms` against the 1 s limit.
- Whether an uploaded source map counts toward the Worker size limit, if `upload_source_maps` is ever enabled.
- Per-request CPU against the Free plan's 10 ms and the Paid default of 30 s. Memory (128 MB) under export, aggregate and listing loads.
- Artifact bytes when built with the pinned Node 24.19.0 instead of 26.9.0.
- Anything listed as remote in `README.md` of this package and in `04-verification-and-cutover.md` (Queue delivery and alarms after inactivity, jurisdiction, PITR, live provider compatibility).

## Restart lane

Recorded 23 September 2026, 17:14–18:00 local, on HEAD `c60c7df` with other agents' uncommitted edits in the tree. The lane runs the shared artifact, not the working tree: `manifest.json` `builtAt` `2026-09-23T14:33:21Z`, source `fcac67397d04` (dirty), `workerSha256` `08e104b8…`; `worker.js` was last modified at 16:33:20 and did not change during these runs. Worker source edits made after that build (for example the uncommitted `cloudflare/analysis/execute.ts`) are not in these results. Local only: no account, credential, provider call or remote binding.

It addresses two gaps listed in section 5: "No Cloudflare fault manifest" and "Process kill of the production `WorkspaceStore`".

### How the lane runs

`npm run test:cloudflare:restart` runs `vitest.restart.config.mts` (Node environment, test files in parallel) over `tests/cloudflare-restart/*.restart.test.ts`. The release check lists it as lane `cloudflare-restart` (`node scripts/cloudflare/check.mjs --list`).

- **Why not `createTestHarness`.** Its `resolveWorkerInputs` (`node_modules/wrangler/wrangler-dist/cli.js:368539`) hard-codes `persist: false` (`:368569`). `tests/cloudflare-restart/runner.mjs` calls `unstable_startWorker` with the same prebuilt derivation `createTestHarness` uses (`main` = the artifact's `worker.js`, `base_dir`, `no_bundle`, `find_additional_modules`, no build command, config `cloudflare/test/wrangler.artifact.jsonc`), plus `dev.persist`, `dev.outboundService`, `dev.server` on `127.0.0.1:0` and synthetic `secret_text` bindings (`tests/cloudflare-restart/synthetic.mjs`). No fallback was needed: the object's SQLite files and the alarm store (`metadata.sqlite`) are written under `<state>/persist/v3/do/openinterviewer-artifact-test-WorkspaceStore/`.
- **Ownership and cleanup.** Each test file owns one `mkdtemp` directory `oi-restart-<label>-*` in `os.tmpdir()`. Persistence, `HOME`, `TMPDIR` and wrangler's scratch directory all live inside it. `userConfigPath` is pointed into it, so `.wrangler/tmp` and the `.dev.vars`/`.env` lookup directory are there too (`getLocalPersistencePath`, `resolveEntryWithMain`, `cli.js:196400`, `:198326`). The directory is removed in `afterAll`. The runner starts with an allowlisted environment and refuses to start if any credential-like variable name is present. The allowlist is `PATH`, `HOME`, `TMPDIR`, `WRANGLER_SEND_METRICS=false`, `WRANGLER_SEND_ERROR_REPORTS=false`, `WRANGLER_HIDE_BANNER=true`, `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, `CLOUDFLARE_INCLUDE_PROCESS_ENV=false` and `NO_COLOR=1`.
- **Outbound.** Only `POST https://api.openai.com/v1/responses` answers, with the synthetic shapes from `tests/e2e-cloudflare/server.mjs` and `fixtureData.mjs`. Every other destination gets 599 and is recorded. Each outbound call is appended with `appendFileSync` to `<state>/events.jsonl` before it is answered, so the record survives the kill. Provider request counts are read from that file across both runtimes.
- **Clients and control.** Clients reach the Worker through an HTTP proxy in the runner process. It logs each request's method and path, never the query. A separate control server in the runner, never in the Worker, can hold synthesis, hold a save reply, or freeze after forwarding one. "Freeze" means the runner sends SIGSTOP to its own children (wrangler's esbuild service and the two `workerd` processes) at the moment the Worker's save reply reaches the proxy. The test's SIGKILL then lands on a runtime that did nothing after the reply, whatever the machine load.
- **Kill and restart.** The runner is spawned detached, so the test first sends SIGKILL to its process group, then to each PID recorded at startup (runner, esbuild, two `workerd`), and waits until none exists. A restart is a new runner on the same state directory.

### Scenarios

| Test (file) | Cut | Observed after the restart, through the Worker API and `events.jsonl` |
| --- | --- | --- |
| `VERIFY-01/JOB-05 a save committed before SIGKILL …` (`committed.restart.test.ts`) | Participant save answered `created`, runtime frozen as the reply was forwarded, then SIGKILL | No synthesis request in runtime 1. In runtime 2, with no request through the proxy, the restored alarm dispatched and the local Queue consumer called the provider. Then status `{status:'complete', generation:1}`, the stored interview has the synthesis and served-model provenance, one interview listed, operator counts `interviews: 1, analysis_jobs: 1`, exactly one synthesis request across both runtimes, nothing refused |
| `VERIFY-01/ST-02 lost save reply …` (same file) | Worker produced the save reply (HTTP 200), the proxy held it, runtime frozen, SIGKILL; the client's request failed | The same save (body, participant cookie, session selector) replayed after restart returns `{success:true, created:false, duplicate:true}`. One interview, operator counts `interviews: 1, analysis_jobs: 1` before and after the analysis completed, exactly one synthesis request |
| `VERIFY-01/JOB-08 a job whose provider call was in flight …` (`lease.restart.test.ts`) | Fixture held the synthesis request (start marker committed, call in flight), SIGKILL | Right after restart, operator status (read-only: sign-in and status arm no alarm) shows `started: 1` and an alarm no later than the lease end. With no further request, the runtime-2 log shows the `watchdog`/`lease-expired` event no earlier than save time + 180 s (`ANALYSIS_CLAIM_LEASE_MS`). Status is then `{status:'failed', generation:1, failureKind:'timeout', recoveryRequired:true}` and operator jobs show `recoveryRequired: 1`. After 5 s more the provider still saw exactly one synthesis request, none in runtime 2 |
| `VERIFY-01/JOB-05 SIGKILL while a transaction holding SQL and an earlier alarm is still open …` (`transaction.restart.test.ts`) | M0 `inside-tx`, made repeatable on a probe object (`txProbe.worker.js`, bundled from source, same `transaction(async)` + `setAlarm` shape) whose open transaction awaits an outbound request the runner never answers | The uncommitted row is absent. The earlier alarm set inside the open transaction never fired. The previously committed row survived, and its own alarm fired unprompted at its deadline |

The surviving alarm in the third scenario can be the dispatch-backoff alarm, about 5 s after the reservation, rather than the lease end. When it finds nothing due, it re-arms for the lease. The first run of the lane (17:24:55, exit 1) asserted the lease end and failed on this. The assertion is now "no later than the lease end".

### Runs

| Run | Start | Command | Exit | Result | Duration |
| --- | --- | --- | --- | --- | --- |
| A | 17:44:42 | `npm run test:cloudflare:restart -- --reporter=verbose` | 0 | 3 files, 4 tests passed | 188.36 s (wall 189 s) |
| B | 17:47:56 | same | 0 | 3 files, 4 tests passed | 188.38 s (wall 189 s) |
| C | 17:56:24 | same, after removing two unused exports from `lane.ts` | 0 | 3 files, 4 tests passed | 188.36 s (wall 189 s) |

Per test, runs A, B and C: committed save 4,902, 4,891 and 4,881 ms; lost reply 4,551, 4,487 and 4,658 ms; open transaction 9,690, 9,729 and 9,663 ms; started call 188,199, 188,198 and 188,195 ms. The 180 s lease is the critical path, and the other files run beside it. After each run no `oi-restart-*` directory remained in `os.tmpdir()` and `ps` showed no runner or `workerd` process with such a path. Earlier development runs: 17:24:55 exit 1 (the assertion above); 17:25:31 exit 0, 188.29 s, 3 tests (before the transaction test existed).

### Where the kill lands (diagnostic, not committed)

`<scratch>/restart/probe.test.ts`, copied into the lane directory only while it ran:

- **Reply-to-provider gap.** Across 5 saves on one runtime, the synthesis request reached the fixture 12, 8, 7, 8 and 9 ms after the client received the save reply.
- **Job state at the kill.** 6 runtimes were group-SIGKILLed at reply + 0 ms, and the persisted object SQLite was copied and read with `node:sqlite`. In 6 of 6 the job was `pending`, dispatch `unsent`, `dispatch_attempts` 0: the alarm had not yet committed a reservation. The runner's freeze makes this cut independent of timing.
- **No request before the provider call.** In one dumped committed-save run, runtime 2 was ready at +2.248 s and its synthesis request arrived at +2.773 s. In between, there was no proxy request and no Worker log line.

### Negative controls

- `txProbe.worker.js` changed to commit before holding the request: the transaction test failed with `expected [ 'committed', 'uncommitted', …(1) ] to not include 'uncommitted'`. The file was then restored.
- Three manifest faults at once (a changed title, `coverage: []` on `M0-KILL-INSIDE-TRANSACTION`, a dropped `scheduler.ts#cleanupSteps` reference) failed three of the seven manifest checks. The manifest was then restored.

### Local Queue caveat

Miniflare's local Queue broker keeps messages in memory (`#messages = []`, `node_modules/miniflare/dist/src/workers/queues/broker.worker.js:198`). A message sent before a kill is lost locally; Cloudflare Queues retain it. The scenarios therefore cut before dispatch (the first two) or after the start marker (the third). The watchdog re-send of a lost delivery is covered only in the workers tier (`CF-DISPATCH-DELIVERY-LOST`).

### Fault manifest

`tests/workers/faultManifest.ts` lists 46 cuts: 41 `CF-*` derived from the code and 5 `M0-*` from the crash probes. They carry 114 coverage references to 105 distinct tests in 23 files, and 21 surfaces are listed as non-cuts (read-only transactions and RPCs, helpers). `tests/unit/cloudflareFaultManifest.test.ts` runs in the Node environment under `npm run test`. Its 7 checks cover:

- unique ids and non-empty fields;
- at least one covering test per cut;
- each covering title is an active `it`/`test` declaration in a file under a lane directory;
- every named symbol exists;
- a source scan finds 53 write or transaction sites in `cloudflare/workspace/*.ts` and `cloudflare/analysis/*.ts`, and 38 `WorkspaceStore` async members, and all of them are accounted for.

`tests/workers/faultCuts.test.ts` adds 3 workers tests for cuts that had none: the M0 throw-after-alarm rollback on the `WorkspaceStore` storage, bootstrap metadata after the migrations, and the watchdog's per-job epoch fence.

| Command | Exit | Result |
| --- | --- | --- |
| `npx vitest run --reporter=verbose tests/unit/cloudflareFaultManifest.test.ts` | 0 | 7 passed |
| `npx vitest run` | 0 | 204 files, 2,636 tests passed |
| `npm run test:cloudflare -- --reporter=verbose tests/workers/faultCuts.test.ts` | 0 | 3 passed |
| `npm run test:cloudflare` | 0 | 22 files, 363 tests passed |

### Not covered by this lane

- **A SIGKILL inside an open production transaction.** No production transaction can be held open from outside. This cut is covered only on the probe object, which uses the same storage API, and by the workers-tier rollback tests.
- **Other providers.** The lane uses the OpenAI adapter only.
- **CI.** `.github/workflows/ci.yml` does not run this lane.
- **Real Cloudflare behavior.** Queue retention across a Worker restart and alarms after inactivity remain remote gates.
