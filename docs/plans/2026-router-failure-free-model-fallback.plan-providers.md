# Provider/Config Plan — router-failure free-model fallback (`pbi-router-failure-free-model-fallback`)

> REVIEWED 2026-09-05 — this doc is frozen history. Normative delta: `2026-router-failure-free-model-fallback.plan-review-folds.md` (overrides on conflict).

Role: PROVIDER/CONFIG design only. Detection/switch → architect lane; test design → test-engineer lane. Read-only; no writes/branches/installs/tests ran.
Sources read: research record + `/tmp/d-487-report.md` + `/tmp/d-488-report.md` + `/tmp/d-489-report.md`, verified against pi **0.85.1** SDK at `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/` and pi-ai at `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-ai/`. (Repo pins 0.84.4 in `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-router-failure-free-model-fallback/package.json` — every pi-API claim below is 0.85.1-verified; 0.84.4 re-check is H8.)

## 0. Verification verdict on the lanes (read before building)

**Confirmed — build on these:**
- Groq baseURL `https://api.groq.com/openai/v1`, OpenAI-compat, tools — matches built-in: `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/providers/groq.js` (`baseUrl`, `api: openAICompletionsApi()`, `envApiKeyAuth("Groq API key", ["GROQ_API_KEY"])`). d-488 §1 Groq row ✓.
- Env/provider IDs: `GROQ_API_KEY`/`groq`, `GEMINI_API_KEY`/`google`, `OPENROUTER_API_KEY`/`openrouter` — `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/providers.md:77-85`. Secrets discipline anchors here.
- `pi.registerProvider` + merge semantics — `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:558-594` (validates via `validateExtensionProvider`, merges defined-over-previous, recomposes, provisional snapshot). d-489 seam ✓.
- `ProviderConfig` field names: `baseUrl` (not `baseURL`), `apiKey` (`$ENV_VAR`/`${ENV_VAR}`/`!cmd` interpolation), `headers` (not `extraHeaders`), `api`, `models`, `refreshModels` — `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1085-1140`, `docs/custom-provider.md:66-186`, `docs/models.md:136-165`. The lane schema's `baseURL`/`apiKeyEnv`/`extraHeaders` are *our* config-layer names; the mapping to pi names must be explicit (PKG-P1).
- Read/auth seams: `hasConfiguredAuth`/`getApiKeyAndHeaders`/`getProviderAuthStatus` — `/Users/arasz/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:29-31`, `model-runtime.d.ts:77-85`. ✓
- Switch semantics: `pi.setModel` returns `false` (no throw) when `!hasConfiguredAuth` — `dist/core/agent-session.js:2050-2053`; session `setModel` reclamps thinking via `_getThinkingLevelForModelSwitch` + `setThinkingLevel` and emits `model_select{source:"set"}` — `dist/core/agent-session.js:1254-1270,1408-1423`. Thinking-reclamp ✓, no-confirm ✓.
- `scopedModels` getter — `dist/core/extensions/runner.js:536`; `models.json` overrides (`baseUrl`/`apiKey`/`headers`/`modelOverrides`) — `docs/models.md:3-190`. ✓
- OpenRouter chain IDs all exist in pi's built-in catalog (366 models, 18 `:free`, scanned `.../pi-ai/dist/providers/data/openrouter.json`): `z-ai/glm-5.2:free`, `poolside/laguna-s-2.1:free`, `minimax/minimax-m3:free`, `thinkingmachines/inkling-small:free` ✓. d-487 chain ✓.
- Groq default `llama-3.3-70b-versatile` exists in built-in catalog (`.../pi-ai/dist/providers/data/groq.json`: `reasoning:false`, ctx 131072); `qwen/qwen3.6-27b` also present (`reasoning:true`). ✓

**Corrections — lanes are wrong here, replan the seam as stated:**
- **C1 (d-488 Gemini default):** `gemini-3.1-flash` and `gemini-3.1-pro` do **not** exist in pi 0.85.1's google catalog (`.../pi-ai/dist/providers/data/google.json`). Real IDs: `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.5/3.6/3.7/3.8-flash`, `gemini-flash-latest`, `gemma-4-26b-a4b-it`, `gemma-4-31b-it`. Corrected defaults: quota `gemini-3.1-flash-lite`, quality escalation `gemini-3.1-pro-preview` (both `reasoning:true`, `thinkingLevelMap:{off:null,…}` → explicit thinking level mandatory on switch).
- **C2 (d-488 OpenRouter default):** `google/gemini-2.0-flash-exp:free` is **absent** from pi's built-in openrouter catalog (scan: no match). Corrected default: `z-ai/glm-5.2:free` (d-487 rank #1, AA coding 68.8, full `tools`+`tool_choice`).
- **C3 (d-488 "Gemini costs one knob: `.../v1beta/openai/`"):** true *only* for a custom openai-compat route. The built-in `google` provider is native (`google-generative-ai`, `.../pi-ai/dist/providers/google.js`: `baseUrl: ".../v1beta"`). Simpler shape: use the built-in natively — **zero knobs, zero `registerProvider`**. The `/openai/` override becomes a rejected alternative (see §4).
- **C4 (d-488 "OpenRouter needs extraHeaders"):** softened. `HTTP-Referer`/`X-Title` is OpenRouter convention (recommended/optional for the API to function, required only for app-attribution features). pi seam exists (`headers`); whether our fallback *must* send them is **HYPOTHESIS H9** (probe: live call without headers).
- **C5 (biggest simplification): `groq`, `google`, `openrouter` are ALL built-in pi providers** (`KnownProvider` in `.../pi-ai/dist/types.d.ts:19`; `.../pi-ai/dist/providers/{groq,google,openrouter}.js`). **No `registerProvider` call is needed for any default.** d-489's "register fallback providers" seam applies only to custom/keyless entries. PKG-P2/P3 are designed around zero-registration + `modelRegistry.find` + `pi.setModel`.

## 1. Packages (mergable units; each with AC + gate)

Conventions: pure selection/cooldown logic in one `-core`-style file (monitor precedent: `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-router-failure-free-model-fallback/extensions/monitor/monitor-core.ts`); factory-with-injected-deps (subagent precedent: `extensions/subagent/index.ts`); TypeBox schemas; per-call env reads (monitor poll-guard precedent); dir package `extensions/router-fallback/` + `package.json` mirroring `extensions/monitor/package.json`; publish via one-line `EXTENSION_DIRS` add in `/Users/arasz/RiderProjects/pi-badger-integration/.ai-badger/worktrees/pbi-router-failure-free-model-fallback/publish.ts:75`.

### PKG-P1 — Config schema + defaults (`extensions/router-fallback/fallback-providers.ts`)

Adopts d-488's schema with three simplifications (§4): no `strategy` discriminator, `maxRpm` optional, pi-name mapping explicit. Built-in entries omit `baseUrl`/`headers` (pi owns them); those fields exist only for `custom` entries.

```ts
interface FallbackRateLimit { maxRpm?: number; cooldownMs: number; maxRetries: number; }
interface FallbackProviderEntry {
  id: string;               // "groq" | "gemini" | "openrouter" | custom slug (failover priority = array order)
  piProvider: string;       // built-in provider id ("groq"|"google"|"openrouter") or registered custom id
  label: string;            // status-notice display name
  apiKeyEnv?: string;       // env-var NAME only; absent = keyless custom (never a built-in)
  model: string;            // primary target model id (pi catalog id)
  models?: string[];        // ordered intra-provider chain (OpenRouter :free rotation); default [model]
  enabled: boolean;
  baseUrl?: string;         // custom entries only → pi ProviderConfig.baseUrl
  extraHeaders?: Record<string,string>; // custom entries only → pi ProviderConfig.headers
  timeoutMs?: number;       // per-attempt ceiling, then advance (proposed default 30_000, HYPOTHESIS H10)
  rateLimit: FallbackRateLimit; // proposed defaults: cooldownMs 60_000 (H10), maxRetries 1 (H10)
}
```

Default order + IDs (justified; H = runtime-resolved):

| # | id | piProvider | model (+chain) | auth env | why |
|---|---|---|---|---|---|
| 1 | groq | `groq` (built-in, openai-completions) | `llama-3.3-70b-versatile` (catalog-verified, `reasoning:false` → thinking `off`, no reclamp risk) | `GROQ_API_KEY` | only workhorse quota (30 RPM/14.4k RPD, H4); drop-in compat; alt escalation `qwen/qwen3.6-27b` documented, not default |
| 2 | gemini | `google` (built-in, **native** `google-generative-ai`, C3) | `gemini-3.1-flash-lite` (C1-corrected); escalation `gemini-3.1-pro-preview` | `GEMINI_API_KEY` | best $0 quality; explicit thinking level required (`off:null` in catalog) |
| 3 | openrouter | `openrouter` (built-in) | `z-ai/glm-5.2:free` (C2-corrected) → chain `poolside/laguna-s-2.1:free` → `minimax/minimax-m3:free` → `thinkingmachines/inkling-small:free` (all catalog-verified; d-487 AA order) | `OPENROUTER_API_KEY` | one-key breadth; 50 RPD burst-only → last; chain entries runtime-resolved (H3): `modelRegistry.find("openrouter", id)` filter, fall back to pinned head |

- AC-P1.1: schema is TypeBox, rejects unknown `piProvider`+missing-`baseUrl` combos for custom entries; built-ins validate against `KnownProvider`. Gate: `bunx tsc --noEmit -p .` + schema unit tests (test-engineer) green.
- AC-P1.2: shipped defaults equal the table above; every HYPOTHESIS default carries its probe id (§5). Gate: defaults snapshot test green; `bun publish.ts --check` in sync after `EXTENSION_DIRS` add.
- AC-P1.3: user reorder/add/disable is order-preserving; `enabled:false` never reorders. Gate: reorder unit test (test-engineer) green.

### PKG-P2 — Auth resolution + skip rule (pure `isEligible(entry, env, authStatus)` in `fallback-providers.ts`; wiring block in `index.ts`)

- Rule: per-call read of `process.env[entry.apiKeyEnv]` + `modelRegistry.hasConfiguredAuth(model)` / `getProviderAuthStatus(piProvider)` (`model-registry.d.ts:29-31`); unset-key built-in → **skip silently, advance** (never error, never block chain); `getApiKeyAndHeaders(model)` resolving `{ok:false}` → skip with status reason. Keyless custom (`apiKeyEnv` absent): eligible only if `enabled` and pi accepts the registration (H11: `validateExtensionProvider` requires `apiKey` unless oauth — keyless likely needs dummy literal + `authHeader:false`; probe before promising keyless).
- Secrets: env names only (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` per `docs/providers.md:77-85`); values never logged/persisted/rendered; `!command`/`$ENV` interpolation left to pi (`docs/models.md:149-165`, `docs/custom-provider.md:186`).
- AC-P2.1: with all three envs unset, resolution yields empty-eligible + status "no fallback auth" (no throw, no `setModel` call). Gate: wiring test with injected env (test-engineer) green.
- AC-P2.2: no secret value appears in logs/cards/snapshots (greppable). Gate: `grep -rE 'sk-|AIza|gsk_'` over extension dir clean + test-engineer guard test green.
- AC-P2.3: `pi.setModel` returning `false` (missing auth race, `agent-session.js:2050-2053`) advances the chain, never throws. Gate: extension test with stubbed `setModel→false` green.

### PKG-P3 — Target resolution (pure `resolveTargets(entries, registry)` + OpenRouter runtime filter)

- Prefer `ctx.scopedModels` non-empty → first chain target inside scope (`runner.js:536`; `model-resolver.d.ts`); else catalog target. Never `persist:true` on `setModel` (preflight constraint; session-only, `agent-session.js:1254-1270`).
- Thinking: after target pick, expose `requiredThinking` — Groq default needs `off` (catalog `reasoning:false`); Gemini/OpenRouter-reasoning targets need explicit level (catalog `thinkingLevelMap`, `_getThinkingLevelForModelSwitch`, `agent-session.js:1408-1423`); the actual `setThinkingLevel` call belongs to the architect's switch block, this package supplies the value.
- OpenRouter churn (d-487): runtime `GET /models` filter (`id.endswith(":free")` + tool-capable) intersected with `modelRegistry.find`; **direct fetch, no `registerProvider` overlay** (simpler than `refreshModels`, which requires a registration to hang off — `types.d.ts:1100-1105`). Caps: catalog fetch failure → pinned chain as-is (degraded, logged).
- AC-P3.1: scoped session resolves in-scope target when available. Gate: test with stubbed `scopedModels` green.
- AC-P3.2: reasoning target always yields explicit thinking level (never relies on ambient). Gate: matrix test over the three defaults green.
- AC-P3.3: stale/rotated `:free` id degrades to next chain entry, never throws. Gate: test with `find→undefined` on head green.

### PKG-P4 — Failover policy table (pure; execution seam with architect)

- Strategy: ordered-failover (d-488 recommendation accepted): advance on network/5xx/429/auth; failing entry goes on `cooldownMs` (eligible again after, **not disabled**); `maxRetries` attempts per entry then advance; `timeoutMs` per attempt then advance; `maxRpm` optional client cap (absent = drive off server 429 + cooldown). Pure core owns the cooldown clock (injected `now`, monitor one-shot precedent); architect owns trigger ingestion + `setModel` invocation. Contract offered: `decideNextTarget(state, event) → {entry, model} | {none, reason}` + `getServingProvider() → {id,label,model} | undefined` (feeds architect's `/fallback` status + `router-fallback` bus transition; subagent `TRANSITION_CHANNEL` precedent, `subagent/index.ts:119`).
- AC-P4.1: 429 on head → head on cooldown, next eligible served; cooldown expiry re-admits head. Gate: injected-clock unit test green.
- AC-P4.2: serving provider is queryable after every switch (powers status/bus, no separate tracking in architect lane). Gate: extension test asserting `getServingProvider()` after stubbed switch green.
- AC-P4.3: never persists fallback as default (`persist` never passed; startup `defaultProvider/defaultModel` untouched, `docs/settings.md`). Gate: guard test asserting no `settingsManager.setDefaultModelAndProvider` call green.

### PKG-P5 — Packaging + docs seams

- `extensions/router-fallback/package.json` (mirror `extensions/monitor/package.json`: `main: index.ts`, deps `pi-coding-agent` + `typebox`); `publish.ts` `EXTENSION_DIRS += "router-fallback"` (one line).
- Docs split: this lane writes the README **provider table + env-var + custom-entry** sections; architect owns overall README + `/fallback` command docs; test-engineer owns gate docs. Seam: provider table references `getServingProvider()` output shape owned here.
- AC-P5.1: `bun publish.ts --check` passes; `--check` never writes (publish.ts contract). Gate: run `--check` pre/post (read-only gate, no install).

## 2. Parallelism

- **Needs from architect:** `index.ts` skeleton region markers for the P2-auth + P4-policy blocks; trigger-event contract (what input feeds `decideNextTarget`); `TRANSITION_CHANNEL` name for `router-fallback`; `/fallback` command output shape consuming `getServingProvider()`; ruling on fetch policy for the P3 `/models` call (allowed? timeout? offline behavior).
- **Offers to architect:** `FallbackProviderEntry` type, `DEFAULT_PROVIDERS`, `isEligible`, `resolveTargets`, `decideNextTarget`, `getServingProvider`, `requiredThinking` — all pure + injected-`now`/injected-env, testable without pi.
- **Offers to test-engineer:** AC table above as test list + CORRECTIONS C1/C2 as regression fixtures (stale IDs `gemini-3.1-flash`, `gemini-3.1-pro`, `google/gemini-2.0-flash-exp:free` must resolve to corrected defaults or clean skip).
- **Serialises:** (a) architect skeleton → our wiring blocks land; (b) H8 (0.84.4 API diff) before final ID freeze; (c) test-engineer review after P1–P4 merge. Parallel-safe now: P1 schema/defaults text, P4 pure policy, docs provider-table draft.

## 3. Secrets discipline

Env names only — `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` (`docs/providers.md:77-85`); custom entries contribute their own `apiKeyEnv` name + `$NAME` interpolation (`docs/custom-provider.md:186`). Per-provider auth failure: skip-and-advance (P2), `setModel→false` advances (P2.3), all-keys-unset yields explicit no-auth status (P2.1); never throw, never persist, never render values (P2.2, P4.3).

## 4. Rejected (simpler-shape review)

- **R1 — `registerProvider` for defaults:** rejected; all three defaults are built-in (`types.d.ts:19`, provider files). Registration reserved for custom/keyless overlays only. Kills an entire failure class (recompose/validation drift, `model-runtime.js:558-594`).
- **R2 — Gemini openai-compat custom provider as default:** rejected; native built-in needs zero knobs (C3). Kept as opt-in custom-entry example only.
- **R3 — Pinned `:free` list:** rejected; runtime fetch + `find` filter with pinned fallback (d-487 churn warning).
- **R4 — `strategy: "ordered-failover"` discriminator (d-488 schema):** rejected; one strategy needs no enum. Reintroduce only with a second strategy.
- **R5 — Mandatory `maxRpm`:** rejected as required; optional. Server 429 + cooldown is the primary limiter; client caps are tuning, and lane quota numbers are H4-unverified.
- **R6 — Cerebras default, Cohere/Together/Fireworks/DeepInfra/Mistral/Z.AI defaults, Pollinations/LLM7 keyless defaults:** concur with d-488 rejections (card-required/expiry/phone-verify/native-adapter/unverified-tools); keyless stays custom-only (H6/H11). Cerebras kept as commented custom example.
- **R7 — Persisting fallback default:** forbidden (preflight); `setModel` session-only.

## 5. HYPOTHESES + settling probes

| # | Belief (source lane) | Probe (settles it) |
|---|---|---|
| H1 | Inkling `tool_choice` forced-auto only (d-487) | live `tool_choice:"required"` call against `thinkingmachines/inkling-small:free`; if strict-forcing fails, demote Inkling below `gemma-4-31b-it:free` |
| H2 | 402 body wording reconstruction (d-487) | one live 402 capture; mitigation already designed: substring + status-prefix match (bodies cut at 4000 chars, `pi-ai/dist/utils/error-body.js`) |
| H3 | `:free` pool churn needs runtime re-query (d-487) | no probe — design decision; P3 fetch-failure path covers staleness |
| H4 | Quota numbers Groq 30/14.4k, Gemini 9k Flash, OR 20/50 (d-487/d-488) | re-check provider docs at build; treat as tunable defaults, never constants (R5) |
| H5 | ZDR+free pool mostly non-ZDR → 503 (d-487) | `GET /api/v1/endpoints/zdr` per-endpoint check; on 503, model-switch not key-rotation |
| H6 | Pollinations no-tools / LLM7 tools-passthrough (d-488) | live `tools` probe per keyless candidate before documenting as example |
| H7 | `gemini-3.1-flash-lite` / `pro-preview` free-tier entitlement (catalog ≠ quota) | live free-key call; failure → swap default to verified-free Gemini id |
| H8 | 0.84.4 ≡ 0.85.1 for `setModel`/`registerProvider`/`model_select` (d-489 caveat) | diff pinned 0.84.4 dist at build; blocks final ID freeze (§2c) |
| H9 | OpenRouter Referer/X-Title optional (C4) | live `:free` call without headers; failure → add static headers to OpenRouter entry |
| H10 | `cooldownMs` 60s / `maxRetries` 1 / `timeoutMs` 30s defaults | test-engineer tuning + live burn-through test; all three user-overridable |
| H11 | Keyless custom registrable (dummy `apiKey` + `authHeader:false`) | registration probe: `validateExtensionProvider` + `hasConfiguredAuth` + live call; failure → keyless documented as models.json-only path (`docs/models.md:37` dummy-key rule) |

## 6. Criterion evidence map

1. PACKAGES with per-package ACs + file seams (§1: P1–P5; seams: `extensions/router-fallback/fallback-providers.ts` new, `extensions/router-fallback/index.ts` marked wiring blocks, `extensions/router-fallback/package.json` new, `publish.ts:75` one-line, README split) — fits architect split via §2 contracts.
2. AC + gate per point (§1 AC-Px.y each with gate); defaults justified (table + verification verdict; C1/C2 corrections flagged; H-items in §5).
3. Parallelism (§2: needs/offers/serialises).
4. Secrets (§3: names from `docs/providers.md:77-85`; per-provider skip/advance behavior P2.1–P2.3, P4.3).
5. HYPOTHESES labelled with probes (§5 H1–H11).