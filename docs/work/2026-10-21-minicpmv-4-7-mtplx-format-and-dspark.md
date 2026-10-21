# Research: MiniCPM-V 4.7 → "the format MTPLX uses", and DSpark as its speculative decoder

**Date:** 2026-10-21
**Question:** Can MiniCPM-V 4.7 be converted into the model format MTPLX uses and served by the
installed MTPLX server, and can the DSpark draft checkpoint
(`openbmb/MiniCPM-V-4.7-35B-A3B-DSpark`) be used for speculative decoding?

**Short answer:** the *full* multimodal checkpoint still cannot be converted — MTPLX's loader
rejects `model_type: minicpmv4_7` — but the **text tower can be turned into a genuine MTPLX
artifact**: MLX trunk + a hand-written `mtplx_runtime.json` contract, which the installed MTPLX
2.12.2 reads, validates and serves on both API dialects (F3–F5). The **MTP sidecar cannot be
manufactured** — no MTP head exists for this architecture and Forge cannot create one — so the
artifact is AR-only (F3, F4). **Speculative decoding does exist for MiniCPM-V 4.7, but not inside
MTPLX**: the DSpark draft runs end-to-end on MLX through mlx-vlm's generic DSpark drafter with no
code change (F7), and in llama.cpp through `--spec-type draft-dspark` (F13) — but on this M4 it is
a **net loss**: 1.9× slower than AR on the 1B (F8), and ~38 % slower than AR on the 35B-A3B,
because the draft's acceptance (1.5 accepted tokens per verification step on prose) is well below
the publisher's 3.5 (F14, F15). Raising the target's precision does not fix the acceptance (F17).
The 35B-A3B itself runs fine here — 33 tok/s with vision (F12).

**Grades:** `[MEASURED]` = ran the command and read the result · `[READ]` = read in a source
authoritative for that claim (path:line, a doc URL) · `[INFERRED]` = reasoned from the findings
above · `[UNVERIFIED]` = not checked.

**Conditions:** every measurement below is on one machine — Apple M4 MacBook Air, 24 GB unified
memory, macOS 27.0.1 — with MTPLX 2.12.2 (mlx 0.32.2, mlx-lm 0.31.3), mlx-vlm 0.7.9 (mlx 0.32.4,
Python 3.15.0) and llama.cpp built from `master` (build b8591-ish, Metal). Each finding quotes
its own command.

**Related records:** `docs/work/2026-10-20-mtplx-format-for-minicpmv.md` (what MTPLX's format is
and why the multimodal checkpoint is refused) · `docs/work/2026-10-20-minicpmv-4-7-1b-runtime-formats.md`
(which runtime takes which format; the DSpark drafter's compatibility gate) ·
`docs/work/2026-10-20-minicpmv-4-7-1b-kit/` (the runnable conversion scripts).

## Findings

### F1 — A real MTPLX artifact is an MLX trunk plus an `mtp.safetensors` sidecar plus an `mtplx_runtime.json` contract [READ]

The Hub has published MTPLX artifacts, and their file list is the format itself: `config.json`,
`model.safetensors` (+ `model.safetensors.index.json`), **`mtp.safetensors`** as a standalone
sidecar, **`mtplx_runtime.json`**, the tokenizer files, `chat_template.jinja`, and the
preprocessor/processor configs. The contract is a JSON document with `arch_id`, `artifact_role`,
`base_trunk`, `exactness_baseline`, `forge_provenance` (recipe, source repo + sha, `forged_at`,
`mtplx_version`), `mtp_contract`, `mtp_depth_max`, `mtp_sidecar`, `recommended_profile`, `sampler`
and `speed_evidence` (acceptance per depth, `forge_verify_rows`).

**Evidence:** `https://huggingface.co/api/models/Youssofal/Qwen3.5-4B-MTPLX-Optimized-Speed/tree/main?recursive=1`
→ the file list above (`mtp.safetensors` 86.7 MB, `mtp/weights.safetensors` 86.7 MB,
`mtplx_runtime.json` 5534 B);
`https://huggingface.co/Youssofal/Qwen3.5-4B-MTPLX-Optimized-Speed/raw/main/mtplx_runtime.json`
→ the contract body quoted above.

### F2 — The runtime contract has six required keys, and `mtp_depth_max` must be positive even for an AR model [READ]

MTPLX parses the contract into a `RuntimeContract` dataclass. Six keys are required —
`mtplx_version`, `arch_id`, `mtp_depth_max`, `recommended_profile`, `exactness_baseline`,
`verified_on` — and `mtp_depth_max` is rejected unless it is **positive**. The dataclass does
carry a `recommended_generation_mode: Literal["mtp", "ar"]` field, so an AR-only artifact can
declare itself as such; but it still has to state a positive MTP depth to be accepted at all.

**Evidence:** `mtplx/backends/registry.py:653-690` (the `RuntimeContract` dataclass and
`from_dict`), quoted:

```python
missing = [
    key
    for key in (
        "mtplx_version", "arch_id", "mtp_depth_max",
        "recommended_profile", "exactness_baseline", "verified_on",
    )
    if key not in data
]
if missing:
    raise ValueError(f"runtime contract missing required keys: {', '.join(missing)}")
...
depth = int(data["mtp_depth_max"])
if depth <= 0:
    raise ValueError("runtime contract mtp_depth_max must be positive")
```

— read from the installed runtime,
`/Users/arasz/Library/Application Support/MTPLX/runtime-venv/lib/python3.14/site-packages/mtplx/backends/registry.py:653-690`.

### F3 — MTPLX reads and validates a hand-written `mtplx_runtime.json`, key by key [MEASURED]

Writing a contract into the exported model directory and running `mtplx inspect` produces a
different error at every step, so the validator is observable from outside:

| contract state | what MTPLX said |
|---|---|
| no `verified_on` | `runtime contract missing required keys: verified_on` |
| `verified_on` present, `mtp_depth_max: 0` | `runtime contract mtp_depth_max must be positive` |
| `mtp_depth_max: 1`, `verified_on` as a string | `dictionary update sequence element #0 has length 1; 2 is required` |
| `verified_on` and `exactness_baseline` as objects, `recommended_generation_mode: "ar"` | `runtime_contract_error: None` — the contract is parsed |

`mtplx forge inspect <dir> --json` then reads the same file back and prints it.

**Evidence:** `mtplx inspect --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-textonly --json`
run four times against the four contract states above, reading
`compatibility.runtime_contract_error` (MTPLX 2.12.2, Apple M4);
`mtplx forge inspect ~/models/minicpmv47/MiniCPM-V-4.7-1B-textonly --json` → the contract
reproduced verbatim.

### F4 — A contract that claims MTP without a sidecar breaks the load; the same contract declaring AR mode loads and answers [MEASURED]

This is the sharp edge of the format. With `mtp_depth_max: 1` and **no** `recommended_generation_mode`,
`mtplx run` fails while injecting a draft head that does not exist:

```
RuntimeError: MTP injection failed for /Users/arasz/models/minicpmv47/MiniCPM-V-4.7-1B-textonly
```

Adding `"recommended_generation_mode": "ar"` (with the reason spelled out) makes the same directory
load and answer normally. `mtplx inspect` on the broken variant had already reported
`mtp_supported: partial`, which is the tell.

**Evidence:** `mtplx run --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-textonly --prompt "Say hello in
exactly three words." --max-tokens 32 --reasoning off` → exit 1 with the traceback above (contract
without a generation mode); the same command after adding `recommended_generation_mode: "ar"` →
`Good morning, I'm here.` and `[mtplx] profile=sustained mode=AR mtp_depth=0 tokens=8 tok_s=53.91`
(MTPLX 2.12.2, Apple M4).

### F5 — The MTPLX-format artifact for MiniCPM-V 4.7-1B serves on the installed MTPLX server, on both API dialects [MEASURED]

The artifact is the text-tower export (MLX trunk, tokenizer, chat template) **plus** the contract —
no `mtp.safetensors`, because no MTP head exists for this architecture. The installed server loads
it, reports AR mode, and answers on the OpenAI and Anthropic dialects:

- `GET /health` → `{"ok":true,"model":"minicpm-v-4.7-1b-textonly","generation_mode":"ar",…}`
  with `load_mtp: false`, `mtp_enabled: false`, `depth: 0`.
- `POST /v1/chat/completions` → `content: "Hello there."` with the MiniCPM thinking block split into
  `reasoning_content` (`reasoning_tokens: 46`).
- `POST /v1/messages` (Anthropic dialect) → a `thinking` block plus `content`.

**Evidence:** `mtplx serve --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-textonly --port 8124
--host 127.0.0.1 --no-auth` → ready in ~15 s, `Model loaded in 2.2s`; the three requests above
(MTPLX 2.12.2, Apple M4 MacBook Air).

### F6 — MTPLX's AR throughput for the 1B text export is 44–50 tok/s [MEASURED]

Three consecutive `mtplx run` invocations with the same prompt and `--reasoning off` produced
identical 57-token answers at 44.11, 49.07 and 49.58 tok/s (`mode=AR mtp_depth=0`).

```chart:range
title: decode throughput, MiniCPM-V-4.7-1B on one M4 (tok/s)
MTPLX AR (text-tower export): 44.1..49.1..49.6
mlx-vlm AR (full multimodal, affine4): 69.0..69.2..71.6
mlx-vlm with DSpark draft: 36.8..36.9..37.3
```

**Evidence:** `mtplx run --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-textonly --prompt "Write a
short paragraph about the sea." --max-tokens 100 --reasoning off` ×3 (MTPLX 2.12.2, Apple M4);
the two mlx-vlm rows come from F8's runs.

### F7 — The DSpark draft loads and runs against MiniCPM-V 4.7-1B on MLX, with no code change [MEASURED]

mlx-vlm's server takes `--draft-model` and `--draft-kind`; pointing it at OpenBMB's DSpark
checkpoint for this model came up as a working speculative drafter:

```
INFO - Loading speculative drafter (dflash): .../MiniCPM-V-4.7-1B-DSpark/snapshots/33762d2…/
INFO - Drafter ready; speculative decoding enabled.
```

and the answers were **byte-identical** to the AR run's answers (same prompt, `temperature: 0`,
three runs each, identical output every time) — the verification step is exact, as the publisher
states.

**Evidence:** `python3 -m mlx_vlm.server --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-affine4
--draft-model ~/.cache/huggingface/hub/models--openbmb--MiniCPM-V-4.7-1B-DSpark/snapshots/33762d223b4be1101cf90abba1958435a9b018e0
--draft-kind dflash --port 8300` (mlx-vlm 0.7.9, Python 3.15.0, Apple M4); the comparison script
compared the `content` of both servers' responses over three runs per server.

### F8 — On the 1B, the DSpark draft is 1.9× *slower* than plain AR [MEASURED]

Same server build, same model, same prompt, three runs each:

| mode | decode rate (tok/s) | median |
|---|---|---|
| AR (no draft) | 69.2, 69.0, 71.6 | **69.2** |
| DSpark draft | 36.8, 36.9, 37.3 | **36.9** |

The 1B target decodes in ~14 ms per token; a 5-layer, 213 M-parameter draft that proposes 15 tokens
per pass cannot recover its own cost at that speed, and the verification pass is not free either.
The draft is a win only where the target is far more expensive per token than the draft — which is
the 35B-A3B case, not the 1B case.

**Evidence:** `python3 -m mlx_vlm.server --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-affine4
--port 8301` (AR) and the same with `--draft-model … --draft-kind dflash --port 8300`; three
`POST /v1/chat/completions` each with `max_tokens: 200, temperature: 0`, reading
`timings.predicted_per_second` (mlx-vlm 0.7.9, Apple M4 MacBook Air).

### F9 — DSpark is a separate draft checkpoint, not an MTP head inside the target [READ]

`openbmb/MiniCPM-V-4.7-35B-A3B-DSpark` ships one file, `model.safetensors` (778 MB), plus a
config: `architectures: ["Qwen3DSparkModel"]`, `model_type: "qwen3"`, `num_hidden_layers: 5`,
`hidden_size: 2048`, `block_size: 15`, `vocab_size: 248144`, and a `dflash_config` with
`projector_type: "dspark"`, `enable_confidence_head: true`, `markov_rank: 256`,
`target_layer_ids: [3, 11, 19, 27, 35]`, `num_target_layers: 40`. The 1B partner is the same
shape at `hidden_size: 1024`, `vocab_size: 248094`, `target_layer_ids: [3, 7, 11, 15, 19]`,
`num_target_layers: 24` (213.5 M parameters).

So the draft is a *third* model that needs the target's hidden states at five layers. It is not
something that can be turned into MTPLX's `mtp.safetensors` sidecar, which is a next-token head
trained inside the trunk.

**Evidence:** `https://huggingface.co/openbmb/MiniCPM-V-4.7-35B-A3B-DSpark/raw/main/config.json`
and `…/MiniCPM-V-4.7-1B-DSpark/raw/main/config.json` (both fetched verbatim);
`https://huggingface.co/api/models/openbmb/MiniCPM-V-4.7-35B-A3B-DSpark/tree/main` → the file
list (`model.safetensors`, 778,452,858 B).

### F10 — MTPLX has no generic "attach a separate draft checkpoint" mechanism [READ]

The only external-draft path in the installed runtime is Gemma-4-specific
(`mtplx/backends/gemma4_assistant.py`, `assistant_model_path`, `uses_external_assistant`), and the
`inspect` JSON's `assistant_model` field is that path — `null` for everything else. There is no
`dspark`, `dflash`, `eagle` or generic draft-model entry point, and MTPLX's own README is explicit
that a separately supplied MTP sidecar cannot be attached to an arbitrary trunk.

**Evidence:** `grep -rn "assistant_model|external_assistant|assistant-model"` over the installed
`mtplx` package → 55 hits, all in `backends/gemma4_assistant.py`, `backends/descriptors.py`
(`ASSISTANT_MODEL_ATTRS = ("assistant_model", "gemma_assistant_model")`),
`hf_loader.py` and `server/openai.py`; `mtplx inspect --model … --json` → `"assistant_model": null`.

### F11 — llama.cpp is the runtime where the DSpark draft is meant to be used [READ]

Upstream `llama.cpp` carries DSpark support (`--spec-type` accepts `draft-dspark`; the GGUF
converter has a `--dspark` flag for exporting draft tensors; `src/llama-arch.cpp` defines
`LLM_TENSOR_DSPARK_MARKOV_W1/W2` and `LLM_TENSOR_DSPARK_CONF_PROJ`). The MiniCPM-V-CookBook
documents the exact pairing for 4.7:

```bash
./llama-server \
  -m  MiniCPM-V-4_7-35B-A3B-Q4_K_M.gguf \
  --mmproj mmproj-model-f16.gguf \
  -md dspark-MiniCPM-V-4_7-35B-A3B-Q8_0.gguf \
  --spec-type draft-dspark --spec-draft-n-max 15 \
  -c 8192 --jinja --port 8080
```

and notes that `llama-mtmd-cli` does **not** support draft models — `llama-cli` or `llama-server`
must be used.

**Evidence:** `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/common/arg.cpp:4315`
(`{"--spec-type"}, common_speculative_all_types_str()`) and `:357-399` (the `spec_type_draft_dspark`
branch); `https://raw.githubusercontent.com/ggml-org/llama.cpp/master/src/llama-arch.cpp:777-779`
and `:1114-1117` (the DSpark tensors);
`https://raw.githubusercontent.com/OpenSQZ/MiniCPM-V-CookBook/main/deployment/llama.cpp/minicpm-v4_7_llamacpp.md`
§4 "Speculative decoding with DSpark", quoted above.

### F12 — The 35B-A3B runs on this 24 GB M4 through llama.cpp, text and vision, at ~33 tok/s [MEASURED]

With a build from `master`, the official 35B-A3B GGUF runs locally: `MiniCPM-V-4_7-35B-A3B-mix_q3gud_im.gguf`
(15.5 GB, the cookbook's memory-constrained quant) plus `mmproj-model-f16.gguf` (1.07 GB), `-c 8192`,
Metal. Text decode runs at ~33 tok/s and the vision path answers correctly about a synthetic image
whose contents are known by construction (a yellow circle with a red triangle on blue — the model
said exactly that).

**Evidence:** `llama-server -m MiniCPM-V-4_7-35B-A3B-mix_q3gud_im.gguf --mmproj mmproj-model-f16.gguf
-c 8192 --jinja --port 8081 --host 127.0.0.1` (llama.cpp `master`, Metal, Apple M4 MacBook Air
24 GB) → `model loaded` in ~5 s; three runs of the prose prompt → 31.29 / 33.04 / 32.65 tok/s; the
image request → `A yellow circle with a small red downward-pointing triangle inside it, set against
a solid blue background.` with 225 prompt tokens (the 16× packing) and 22 generated.

### F13 — The DSpark draft works for the 35B-A3B in llama.cpp and is exact [MEASURED]

`--spec-type draft-dspark -md dspark-MiniCPM-V-4_7-35B-A3B-Q8_0.gguf` loads the draft as a
`draft-dflash` speculative model with `n_max=15, block_size=15, mask_token_id=248076, n_extract=5,
sample_from_anchor=true`, and the server reports `draft_n` / `draft_n_accepted` per response. The
text is **byte-identical** to the AR server's text (same prompt, `temperature: 0`), and the image
caption matches too.

**Evidence:** `llama-server … -md dspark-MiniCPM-V-4_7-35B-A3B-Q8_0.gguf --spec-type draft-dspark
--spec-draft-n-max 4 -c 8192 --jinja --port 8080` (llama.cpp `master`, Metal, Apple M4);
the log line `common_speculative_impl_draft_dflash: - n_max=15, block_size=15, …`;
`diff` of the two responses' `content` fields → identical for the prose prompt and for the
image request.

### F14 — On this machine the DSpark draft is a net loss, and the loss grows with the proposal block [MEASURED]

Same target GGUF, same machine, same prompt, three runs each:

| mode | prose tok/s | code tok/s |
|---|---|---|
| AR (no draft) | 31.29 / 33.04 / 32.65 | 32.69 / 32.98 / 32.82 |
| DSpark draft, `--spec-draft-n-max 4` | 19.57 / 22.76 / 20.25 | 33.07 / 36.78 / 33.71 |
| DSpark draft, `--spec-draft-n-max 15` | 7.32 / 9.39 / 9.21 | not measured |

So on prose the draft is ~38 % *slower* than AR; on code it is a wash (medians 33.7 vs 32.8, inside
the run-to-run spread). Widening the proposal block from 4 to 15 makes it ~2× worse again: the
draft's cost scales with how many tokens it proposes, while the acceptance does not.

**Evidence:** three `POST /v1/chat/completions` per cell (`max_tokens: 128, temperature: 0`),
reading `timings.predicted_per_second` from each response; the three server configurations above
(llama.cpp `master`, Metal, Apple M4 MacBook Air 24 GB). The AR and draft runs were done
**sequentially**, one server at a time.

### F15 — Draft acceptance is far below the publisher's numbers, and it is domain-dependent [MEASURED]

The DSpark card defines acceptance length as *completion tokens divided by speculative verification
steps*. Measured here (`--spec-draft-n-max 4`, so a step proposes 4 tokens):

| prompt | proposed | accepted | steps | accepted tokens per step |
|---|---|---|---|---|
| prose | 176 | 65 | 44 | **1.48** |
| code | 112 | 98 | 28 | **3.50** |

The publisher reports 3.501 (general), 5.347 (code), 5.891 (math) for this pair — i.e. roughly
**2–3× higher** than measured here. The ordering matches (code above general), but the level does
not. The most plausible cause is the target's quantization: the draft was trained against the
bf16 target's hidden states, and this run's target is an IQ3-mix quant, which changes them.

**Evidence:** `timings.draft_n` and `timings.draft_n_accepted` from the responses of F14;
`https://huggingface.co/openbmb/MiniCPM-V-4.7-35B-A3B-DSpark/raw/main/README.md` (the acceptance
length table, quoted for the comparison).

### F16 — Only one 35B server fits in 24 GB of unified memory [MEASURED]

Starting a second 35B server while the first was running failed two ways: the second died at load
with `ggml_metal_synchronize: error: command buffer 0 failed with status 5` /
`Insufficient Memory`, and the *running* server then failed a request with
`decode: Compute error. off = 0, n_batch = 2048, ret = -3`. Every measurement above was therefore
taken with one server at a time.

**Evidence:** the two log excerpts above from `/tmp/mc47run/llama35_base2.log` and
`/tmp/mc47run/llama35_d4.log` (llama.cpp `master`, Metal, Apple M4 MacBook Air 24 GB).

### F17 — The draft's acceptance does not improve with a higher-precision target, so the target's quantization is not the cause [MEASURED]

The obvious explanation for the low acceptance (F15) was that the draft was trained against the
bf16 target's hidden states, and an IQ3-mix target changes them. It does not hold: the same draft
against a **higher-precision** target (`MiniCPM-V-4_7-35B-A3B-IQ4_XS.gguf`, 18.7 GB, q8_0 KV,
`-c 4096`) lands in the same place.

| target quant | prose: proposed/accepted, accepted per step | code: proposed/accepted, accepted per step | AR prose | AR code |
|---|---|---|---|---|
| IQ3-mix (15.5 GB) | 176 / 65 → **1.48** | 112 / 98 → **3.50** | 32.7 tok/s | 32.8 tok/s |
| IQ4_XS (18.7 GB) | 205 / 75 → **1.46** | 110 / 99 → **3.60** | 34.1 tok/s | 24.7 tok/s |

and the draft is a loss there too: prose 17.2–19.5 tok/s against AR's 28.8–34.1, code 12.3–15.0
against AR's 22.9–25.0.

So the acceptance shortfall is a property of *this* setup — the draft's own quantization, the
llama.cpp dflash round loop, or the prompt mix — and not of the target's precision. Which of
those it is was not isolated here.

**Evidence:** the two server configurations above (llama.cpp `master`, Metal, Apple M4 MacBook
Air 24 GB, one server at a time), three `POST /v1/chat/completions` per cell, reading
`timings.predicted_per_second`, `timings.draft_n` and `timings.draft_n_accepted`.

### F18 — The llama.cpp installed on this machine can run neither 4.7 nor DSpark [MEASURED]

The Homebrew build (`llama-server`, version 0.7.0, build 11669) contains no `dspark` and no
`minicpm` strings at all, so it predates both the 4.7 support (PR #29416) and the DSpark draft
support. A build from `master` is required.

**Evidence:** `strings -a /opt/homebrew/bin/llama-server | grep -ci dspark` → `0`;
`… | grep -ci minicpm` → `0`; `llama-server --version` → `version: 0.7.0 (build 11669, commit
620d2225c)` (Homebrew, AppleClang 21.0.0.21000334 for Darwin arm64).

## Still open

- **What** the low draft acceptance (1.5 accepted tokens per verification step on prose) is
  actually caused by. The target's quantization is now ruled out (F17); the remaining candidates
  are the draft's own quantization (Q8_0 here vs F16 upstream), the llama.cpp dflash round loop,
  and the prompt mix. Each needs its own run — a F16 draft (0.79 GB) is the cheapest next test.
- Whether the published acceptance lengths (3.5–6.7 tokens per verification step, depending on the
  domain) reproduce on this hardware with an unquantized target; they are the publisher's numbers,
  read from the model card, and were measured on iPhone/iPad with their own runtime.
- Whether the MTPLX artifact's contract survives an MTPLX **upgrade** — the contract is parsed
  strictly, and a future version may require fields this hand-written one lacks.
- Whether a MiniCPM-V 4.7 **vision** path exists inside MTPLX at all: MTPLX's vision code is
  ported for the Qwen3-VL and Gemma 4 towers only, and MiniCPM-V 4.7's is SigLIP-based, so the
  multimodal checkpoint cannot be served by MTPLX in any format.
- Whether the MTPLX text-tower export is worth its cost: it drops the vision tower, so an agent
  that needs images must stay on mlx-vlm (F5) — the two runtimes are not interchangeable.
