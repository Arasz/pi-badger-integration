# ADR — PKG-5 registry source: import-from-target-project + frozen fallback

Status: **ratified in-lane** (PKG-5 5a, 2026-09-06). Lean from the dispatch brief confirmed;
alternatives overturned below with reasons. This record is the S2-style in-lane decision log
for the registry-source question (OQ-6), owned by PKG-5 per routing §5/M-notes.

## Verdict

**IMPORT.** At delegation time, pbi reads the *target project's*
`<cwd>/.ai-badger/model-groups.json` (the same project root `scanPersonas` reads
`.pi/agents` from — one root predicate, no second path). It never reads the ai-badger
framework repo, and it vendors **no copy** (no mirror).

**ABSENCE RULE.** Missing, unreadable, unparseable, or structurally unusable registry file
→ degrade to the frozen fallback (`FROZEN_MODEL_GROUPS` in `delegation-core.ts`) **with a
warning** (`ui.notify`, naming the file + rule). Degradation is loud, never silent, never
fatal — delegation must not brick on projects the registry has not reached yet. Precedent:
the router's degrade-on-stale pinned chain (`DEFAULT_PROVIDERS` in
`extensions/router-fallback/fallback-providers.ts`); house convention: `scanPersonas`
degrade-loudly-never-throw (row 4).

Present-but-invalid file degrades the same way (warning names the rule). A corrupt file
bricking delegation would violate the extension's core defect contract; the loud warning
is the "fail loud" half, the fallback is the "never brick" half.

## Overturned alternatives

- **MIRROR (vendored copy):** overturned. A vendored copy makes `bun publish.ts --check`
  red in every checkout until an install runs (exact file-set equality, M4), needs a sync
  test against the ai-badger canonical, and can serve stale tiers silently. Import is
  never stale by construction.
- **AI-BADGER-REPO PATH:** overturned. The delegation target is often not an ai-badger
  checkout; coupling pbi to the framework repo's location reintroduces the adjacency
  failure the router precedent already rejected.

## Frozen fallback provenance

Preferred pins only, copied from the PKG-1 canonical
(`tiers/pkg1-registry:.ai-badger/model-groups.json`, read-only):

- low → `openrouter/z-ai/glm-5.3-flash`
- medium → `openrouter/meta/muse-spark-1.3-contributor`
- high → `openrouter/meta/muse-spark-1.3-contributor`

Marked `{ frozen: true }` so telemetry (`registryVersion` surfacing per contract §4.10)
distinguishes degraded resolutions. Refresh: manual re-pin against PKG-1 canonical when
preferreds rotate (no automation this task; G1 follow-up).

## Consumer posture (binding on 5b/5c)

1. **Order-agnostic read.** The resolver returns `groups[level][0].id` verbatim (contract
   §4.6). Preferred-first, lexicographic price order, intra-group uniqueness, and the
   **demoted-tail exemption** (frozen input: `sonnet-5`-class tail pinned LAST with
   `revisionWatch`, exempt from price order) are PKG-1 validator territory — the consumer
   branches on none of them. T-DUP / T-ONEPREF / T-LEX therefore have **no pbi half**;
   T-FAKESHAPE's pbi half is fixture shape only (member-objects with `preferred` flags,
   never string lists). The `[0] == preferred` coincidence is the validator's guarantee,
   consumed verbatim — a consumer selecting by flag would silently accept registries the
   validator rejects.
2. **Re-validate before emit (M8).** The registry file is project-writable (contributor /
   PR surface) yet renders into `pi -p --model <id>` argv. The resolver re-validates the
   resolved id against the tight pattern `^openrouter/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`
   before emitting; mismatch → throw naming the rule, never emit. Explicit `model:` pins
   pass verbatim (contract §4.5; grandfather clause for legacy bare pins + `fallbackArgsFor`
   retry unchanged).
3. **G-6 implemented verbatim, once** (`resolveDelegationModel` in `delegation-core.ts`):
   tool-override (queue group `model:`) > frontmatter `model:` > `level:`-resolved >
   session model. Effective level for queue = group `level:` param ?? persona `level:`
   (call-time beats file, mirroring the model ranking). Fallback retry target stays the
   session ("parent") model.
4. **A7 + S5 resolution (F1-vs-S5 ruling).** `level` is validated even when overridden —
   never silent. Deciding pin invalid → raise (`InvalidLevelError`, §5 shape). Non-deciding
   pin (frontmatter `level:` overridden by an explicit model) → **warn** (stale lane files
   must not brick currently-passing explicit-model delegations). Asymmetry, deliberate:
   **tool-supplied** `level:` (queue param — live caller input, G5) → always a usage error
   when unknown, even when overridden; **file-supplied** `level:` → S5 warn path.
5. **Override recorded like `modelFallback`.** Valid level overridden by an explicit model
   rides the result note (`levelOverride`) and the card verdict names it — never silent.
6. **Dual-key frontmatter (G-2/G-3).** `parsePersona` loads raw `level:` + `model:`
   strings (trimmed, non-empty); no reader-side stripping — PKG-4's delivery rule (level
   passes, model passes iff `openrouter/`-qualified) describes the *delivered files*, and
   stripping in pbi would break the grandfathered bare-pin fallback the existing suite pins.
   Validation happens at resolve time, where the override context exists.
7. **Core placement.** The resolver lives in `delegation-core.ts`'s pure half (no imports,
   no clock, no fs — house rules hold): `delegation-queue.ts` cannot import `index.ts`
   (no-cycle rule R4/S6), so the shared pure resolver + G-6 helper + frozen fallback must
   sit below both. The fallback interplay (level-resolved pins arming `fallbackArgsFor`)
   is what requires the core placement.
