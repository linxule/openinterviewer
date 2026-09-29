# Model defaults and compatibility: 29 September 2026

This is the dated evidence for the 5.0.0 default update, not a promise of future model availability or account access. Existing studies retain their explicitly configured provider and model. No stored study, consent commitment or interview provenance is migrated by changing defaults.

## Defaults and choices

| Provider | New default | Other newly available choices |
| --- | --- | --- |
| OpenAI | `gpt-6.1-sol` | `gpt-6-sol`, `gpt-6-luna` |
| Anthropic | `claude-sonnet-5-5` | None added beyond the balanced default |

OpenAI describes [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) as near-Astra capability at lower cost. It supports structured outputs through the existing Responses API. GPT-6 Luna is an explicit lower-cost choice, not the research default; no Astra upgrade or automatic model router is introduced.

The [Vercel catalog](https://vercel.com/ai-gateway/models) and its credential-free [model metadata endpoint](https://ai-gateway.vercel.sh/v1/models) listed `openai/gpt-6.1-sol`, `openai/gpt-6-sol`, `openai/gpt-6-luna` and `anthropic/claude-sonnet-5.5` on this date. The catalog listed standard input/output prices per million tokens of $2/$10 for both Sol models and Sonnet 5.5, and $0.10/$0.50 for Luna. Gateway prices are a dated catalog observation, not a billing guarantee.

Native Anthropic uses the dash-form ID; Vercel uses the dot-form alias above. Cloudflare AI Gateway retains each provider's native API and model ID rather than Vercel aliases.

## Request compatibility

GPT-6.1 Sol rejects `none` and `minimal` reasoning effort. The native adapter's existing reasoning switch therefore requests `medium` when enabled and `low` when disabled; earlier models, GPT-6 Sol and Luna retain `none` when disabled. Unspecified reasoning remains provider-default. Vercel Gateway retains its existing provider-default reasoning behavior. No sampling overrides are sent. See the [model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).

For [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5), the native adapter uses `thinking: {type: 'between_tools'}` when reasoning is disabled, with no extra thinking fields or effort override. Reasoning enabled retains adaptive thinking. SDK 0.127.0 does not yet declare `between_tools`; a local request-construction type extension sends the documented wire value, covered by real-SDK synthetic HTTP tests.

The adapter already uses native `output_config.format`, not forced tool calls. It selects text by block type, sends no sampling parameters, and does not replay provider thinking blocks. Computer/advisor tool changes do not apply: this application declares neither. Refusals fail closed, even if returned text happens to match the schema; no repair, alternative model or server-side fallback is configured.

## Verification boundary

Credential-free regressions cover strict request schemas, reasoning compatibility, native Cloudflare paths and exactly six `cf-aig-*` headers, creator-only Vercel routes, no automatic exploration retries, served-model provenance and continued acceptance of legacy study model IDs. Public catalog reads make no inference about paid execution compatibility. Live smoke evidence, when run, is separate from this document; no Anthropic paid call was authorized for this update.
