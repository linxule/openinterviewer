# Favicon follow-up — 7 September 2026

Status: diagnosis complete; needs Xule's design decision, then a small asset implementation. No design or implementation performed.

Source: Xule's observation and the bounded Daily Desk handoff to the existing OpenInterviewer task. Icon design is reserved for a later session with Claude and Kimi. Owner: Xule for design approval; this project for subsequent implementation. Trigger: Xule starts that session or supplies an approved icon. No deadline or monitor created.

## Repository evidence

Checked local `main` at `fe1cb92bcec56ad1d638543b20e48fa5f7c8597a` on 7 September 2026.

- No favicon, app icon, Apple icon, manifest, or standalone image asset exists among tracked and normal untracked project files. There is no `public/` directory. User-owned `.claude/` and generated/dependency directories were excluded from the asset inventory.
- [Root metadata](/Users/xulelin/Documents/Apps/openinterviewer/src/app/layout.tsx:28) and [demo metadata](/Users/xulelin/Documents/Apps/openinterviewer/src/app/demo/page.tsx:4) declare title/description, with no icon metadata. No manual icon links or generated icon routes were found.
- [Proxy configuration](/Users/xulelin/Documents/Apps/openinterviewer/src/proxy.ts:44) excludes `/favicon.ico`; this does not create an asset. The missing favicon is not explained by that matcher.
- [ResearcherShell](/Users/xulelin/Documents/Apps/openinterviewer/src/components/shell/ResearcherShell.tsx:50) uses a text-only wordmark. [Slice C](/Users/xulelin/Documents/Apps/openinterviewer/docs/design/slice-C-spec.md:45) explicitly specifies no icon/logo mark for that shell; it does not decide a future browser favicon.
- [UI Icon](/Users/xulelin/Documents/Apps/openinterviewer/src/components/ui/Icon.tsx:4) provides generic action glyphs; [OAuthLogin](/Users/xulelin/Documents/Apps/openinterviewer/src/components/OAuthLogin.tsx:40) embeds third-party sign-in marks. Neither is an approved OpenInterviewer brand asset to reconnect. No Next/Vercel default favicon was found.

## Live evidence

Canonical origin from README: https://openinterviewer.vercel.app. Anonymous HTTP checks at **2026-09-07 13:11:09 UTC / 15:11:09 CEST** sent `Cache-Control: no-cache` and `Pragma: no-cache` without credentials.

| URL | Observed result |
| --- | --- |
| https://openinterviewer.vercel.app/ | 200 HTML; title OpenInterviewer; no icon, Apple icon, or manifest link |
| https://openinterviewer.vercel.app/favicon.ico | 404 HTML, `X-Matched-Path: /404`; no image |
| https://openinterviewer.vercel.app/icon.svg | 404 HTML |
| https://openinterviewer.vercel.app/apple-icon.png | 404 HTML |
| https://openinterviewer.vercel.app/manifest.webmanifest | 404 HTML |

A background in-app browser also loaded and reloaded the homepage: its hydrated DOM had no icon/manifest links. Direct browser navigation to `/favicon.ico` visibly rendered the 404 page; captured network response was **404, text/html, fromDiskCache=false, fromServiceWorker=false**. The homepage reload did not emit an automatic favicon request in this browser, so that particular browser behavior is not claimed as verified.

The HTTP responses were Vercel cache HITs; no cache purge was attempted. The source absence, absent live metadata, and actual 404 response support **missing asset plus missing declaration**, with no suitable asset to rewire and no observed deployment/source mismatch. A stale icon in Xule's particular browser was not inspected; browser caching cannot by itself explain the absent repository asset and fresh client request returning 404. No deployment SHA/build audit was needed or performed for this bounded finding.

## Later design brief and smallest implementation

Request one approved square site mark that remains recognizable at 16px and 32px, checked on light and dark browser chrome and against the existing [decided direction](/Users/xulelin/Documents/Apps/openinterviewer/docs/design/DIRECTION-final.md:9). Shape, motif, lettering, colors, and background treatment remain Xule's decisions with Claude and Kimi. Do not change the application's text wordmark as part of the favicon follow-up.

Minimal design handoff: editable vector master and `favicon.ico` with 16×16 and 32×32 variants; 48×48 can be included. Optional later exports are a scalable SVG browser icon and 180×180 PNG Apple icon. A manifest/PWA bundle is unnecessary for the missing browser-tab icon.

After approval, the smallest implementation is to add the approved ICO at `/Users/xulelin/Documents/Apps/openinterviewer/src/app/favicon.ico`. The installed [Next metadata file-convention documentation](/Users/xulelin/Documents/Apps/openinterviewer/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md:17) confirms automatic head wiring, so no manual layout edit is needed. Optional later files would be `src/app/icon.svg` and `src/app/apple-icon.png`.

Future acceptance check: verify the ICO decodes at the intended sizes, a production build emits the icon link, `/favicon.ico` returns 200 with an image MIME type, and a fresh browser displays it. Live verification follows a separately authorized deployment.

## Scope and preservation

Only this local status record and the requested Daily Desk receipt were written. No application edits, image generation, Claude/Kimi or provider calls, credential access, database access, commit, push, deployment, or automation. Prior optimization/provider-smoke work was not restarted. The two pre-existing untracked smoke-test copies remain untouched. The dated Daily Desk note remains owned by the desk and was not edited.

Recorded: 2026-09-07T15:14:48+02:00
