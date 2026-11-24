# Arcwise progress

Updated 24 Nov 2026.

## Stack as built

One Node 22 process: **Express** serves `/api/*` (`server/routes.ts`) and hands every other request to **Next.js 15** (App Router, `app/`). The analysis engine lives in `server/engine/`. Tests: Vitest, 50 passing. `tsc --noEmit` is clean.

This differs from the monorepo layout in `prompt.md` section 3 (pnpm workspaces, `apps/worker`, BullMQ, Postgres). The engine sits behind small interfaces so that swap is mechanical:
- `server/store.ts`: file-backed JSON store in `.data/`. Replace with Drizzle + Postgres + object storage.
- `server/jobs.ts`: in-process queue (concurrency 2). Replace with BullMQ on Redis.
- `server/engine/llm.ts`: `Llm` interface. Anthropic implementation, plus `NullLlm` for tests and keyless runs.

## Done

**Milestone 1, scaffold:** done, with the single-process layout above. Includes a Dockerfile and `docker-compose.yml` for the app.

**Milestone 2, Understand:** mostly done.
- Public GitHub URL, branch list via `git ls-remote`, shallow clone into a temp dir that is deleted afterwards. Limits: 20,000 files and 500 MB.
- Parsing: files, functions, imports, layers and side effects for TS/JS/Python.
- 3D graph (three.js, instanced meshes), tours ordered by dependency, search, and an "Explain like I'm new" switch.
- A source viewer with line highlighting. Its copy of the source has secrets redacted.
- Incremental runs: content hashes per file, "changed since last analysis", and LLM summaries reused for unchanged files.

**Milestone 3, Cost:** done.
- Detects call sites for OpenAI, Anthropic, Google, Vercel AI SDK, LangChain, LiteLLM and raw HTTP.
- Resolves the model from literals, constants and env defaults; anything else is marked "dynamic".
- Resolves system prompts: inline, constants (including imported ones) and prompt files.
- `pricing.json` carries a source and a checked date per model; `npm run pricing:check` flags stale entries.
- Analyzers: model fit, prompt caching, output caps, batching, prompt bloat, context trimming and redundant calls.
- Headline savings take the best option per call site, so nothing is counted twice.
- The prompt optimiser rewrites via Claude, or with rules when no key is set, and shows an instruction checklist.
- The help-desk fixture shows 6 call sites, the 12,005-token static prompt and the redundant classify/route pair.

**Milestone 4, Risks:** done except hotspots.
- Rules: secrets (masked, with an entropy check), SQL concatenation, empty catch, HTTP without timeout, LLM calls without max tokens or error handling, unvalidated JSON from a model, floating promises, untested central files.
- Dependency vulnerabilities via OSV.
- Optional LLM review, with each quote verified against the cited lines.
- `verifyFindings` drops any finding whose lines don't exist.
- Blast radius, plus feedback per repository that suppresses repeats.

**Milestone 5, Quality gate:** engine done, live replay not yet run against real keys.
- Bring-your-own keys with AES-256-GCM envelope encryption.
- JSONL inputs, or synthetic inputs labelled as such.
- Cost estimate and a confirm step before any replay.
- Replay with concurrency limits and retries.
- Scoring: classification, structured output, extraction, a position-swapped judge, and assertions.
- Bootstrap 95% interval gate, then a ledger entry or an "At risk" result, and a shareable report page.

**Milestone 6:** partly done. Usage import is done (OpenAI and Anthropic CSV, Langfuse, Helicone, OpenTelemetry GenAI JSON), as are INR/USD with a dated rate, incremental re-analysis and shareable reports.

## Not done yet

- GitHub OAuth sign-in and the Arcwise GitHub App for private repos. There is no auth yet, so every analysis is visible to anyone who can reach the server. **Do not expose this server publicly yet.**
- Vendoring Understand-Anything `core` and `dashboard` (`packages/ua-*`), web-tree-sitter parsing, and the `ai-cost` graph kind in the upstream schema. The current extractor is lexical and sits behind the same functions (`extractFunctions`, `extractImports`).
- Hotspots, which need git churn and therefore a deeper clone.
- Response-caching analysis, which needs per-prompt usage data.
- Judge calibration UI. Automatic re-validation when the model, prompt or price changes.
- Playwright smoke test. ESLint config. CI workflow.
- Prices in `pricing.json` are dated 2025-10-01 and must be re-checked (`npm run pricing:check` will flag them).

## Next

1. GitHub OAuth (Auth.js) plus per-user ownership checks on every route. This is needed before any shared deployment.
2. Postgres (Drizzle) and BullMQ behind `store.ts` and `jobs.ts`.
3. Vendor `ua-core` and switch the extractor to web-tree-sitter.
4. A Playwright smoke test over the help-desk fixture.
