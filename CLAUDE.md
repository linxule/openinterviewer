# OpenInterviewer

Read `AGENTS.md` before changing this repository. It is the canonical architecture, trust-boundary, navigation, and verification guide for all coding agents. `README.md` and the guides it links in `docs/` own user and operator setup.

Do not duplicate durable project guidance here: duplicated instructions drift. Preserve the Next-managed block below when editing this file.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
