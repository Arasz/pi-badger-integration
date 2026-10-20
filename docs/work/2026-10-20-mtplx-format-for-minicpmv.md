# Research: converting MiniCPM-V-4.7-1B into "the format MTPLX uses"

**Date:** 2026-10-20
**Question:** What is the model format MTPLX (mtplx.com) expects, and how would MiniCPM-V-4.7-1B be converted into it?

**Short answer:** the full multimodal checkpoint cannot be converted — MTPLX's loader rejects
`model_type: minicpmv4_7` (F9). But MiniCPM-V 4.7's text tower is a Qwen3.5 text model, and
exporting *that* alone — drop the vision and merger tensors, rewrite `config.json` to
`model_type: qwen3_5` with the original `text_config` — gives a directory MTPLX runs
autoregressively at ~50-65 tok/s on an M4 (F10, F11). The cost: no image input, no speculative
decoding, and `--reasoning off` to suppress the MiniCPM thinking block (F12).

**Grades:** `[MEASURED]` = ran the command and read the result (the evidence line names the
command, the machine and the conditions) · `[READ]` = read in a source authoritative for that
claim (path:line, a doc URL, a spec section) · `[INFERRED]` = reasoned from the findings above
(the reasoning is named) · `[UNVERIFIED]` = not checked (what would settle it is named).

**Conditions:** every measurement below is on one machine — Apple M4 MacBook Air, 24 GB unified
memory, macOS 27.0.1; MTPLX 2.12.2 (mlx 0.32.2, mlx-lm 0.31.3, Python 3.14.5) and mlx-vlm 0.7.9
on Python 3.15.0 (mlx 0.32.4). Each finding quotes its own command.

**Reproduce:** `scripts/convert_minicpmv47.sh` (in the sibling record's directory) builds the
checkpoints and this export; `scripts/export_mtplx_textonly.py <src> <dst>` does the export on its
own; F17 is that script re-run from a clean machine state.

## Findings

### F1 — "The MTPLX format" is an MLX build plus a trained MTP head sidecar plus a runtime contract file [READ]

MTPLX's artifact is not a special file format — it is a directory: the MLX safetensors build of the
trunk, the model's own multi-token-prediction head extracted into a standalone `mtp.safetensors`
sidecar, and a `mtplx_runtime.json` provenance contract that records the construction. `mtplx forge
build` is the pipeline that produces it: download → convert (`to_mlx`) → calibrate
(`extract_mtp` / `pack_sidecar`) → verify → brand. The head is deliberately *not* kept embedded in
the trunk shards, because mlx-lm's own loader would then apply its norm restoration a second time
and collapse acceptance.

**Evidence:** `README.md` (MTPLX repo, "Forge: make your own MTP models", "Model libraries");
`docs/model-compatibility.md` ("An MTPLX-branded pack stores its MTP head as a standalone
`mtp.safetensors` sidecar"); `docs/FORGE_BACKEND_CONTRACT.md:1-60` (CLI surface and the
`forge build` run-dir layout with `convert.json` / `calibrate.json` / `verify.json`).

### F2 — Forge does not convert plain models; it only builds MTP artifacts from sources that already have MTP weights [READ]

The code says this outright. A probed source without an MTP head gets: "Source has no MTP head, and
Forge currently builds speculative MTP artifacts only; it cannot create missing trained MTP
weights. AR-only Forge conversion/quantization is not supported yet. For runtime-compatible
checkpoints, use mtplx run / mtplx serve directly with MTP disabled (mtp_off)."

**Evidence:** `mtplx/commands/forge.py:474-497` (`_no_mtp_probe_message`; the no-MTP message is its final return, lines 487-492), quoted verbatim.

### F3 — MTPLX's architecture catalog contains no MiniCPM entry, and no vision tower beyond Qwen3-VL and Gemma 4 [READ]

`SUPPORTED_ARCH_IDS` lists thirteen architectures (laguna-s-2.1-ar, deepseek-v4, qwen4-next,
qwen3-next-mtp, deepseek-v3-mtp, glm-moe-dsa-mtp, glm4-moe-mtp, glm4-moe-lite-mtp, mimo-mtp,
nemotron-h-mtp, gemma4-assistant-mtp, step3p5-mtp, hy-v3-mtp) and `ARCHITECTURE_CATALOG` adds
twenty-seven keys — none of them MiniCPM. The only MiniCPM in the whole source tree is
`openbmb/MiniCPM5-1B`, cited as a *text* llama-architecture example for the experimental AR-only
lane. MTPLX's vision code is ported from mlx-vlm for the Qwen3.5/Qwen3-VL tower and the Gemma 4
assistant only.

**Evidence:** `mtplx/backends/registry.py:19-36` (`SUPPORTED_ARCH_IDS`), `:131+`
(`ARCHITECTURE_CATALOG` keys), `:195-219` (the `llama-ar` entry naming MiniCPM5-1B);
`mtplx/vision/qwen3_vl_tower.py:1-8` and `mtplx/vision/processing.py:1` (port scope);
`rg -il minicpm` over the unpacked repo → only `mtplx/backends/registry.py` and
`tests/test_artifacts.py`.

### F4 — A checkpoint with no MTP head is classified `no-MTP`, and the runtime exits 2 [READ]

The compatibility table defines five tiers: Verified, Architecture-compatible-unverified, AR-only,
Incompatible architecture, and No MTP ("Exit with a clear message"). `EXIT_NO_MTP = 2` in the
registry. The AR-only tier is documented as narrow by design — it currently recognises exactly one
checkpoint, `mlx-community/Laguna-S-2.1-oQ4e` at a pinned revision, with a pinned source marker,
all 13 shards at reviewed sizes, the index, tokenizer, generation config, special-tokens map and
chat template.

**Evidence:** `docs/model-compatibility.md` (tier table and the Laguna paragraph), and
`mtplx/backends/registry.py:36-45` (upstream `main`, fetched 2026-10-20) — the tier and exit-code
constants, quoted:

```python
TIER_ARCH_COMPATIBLE_UNVERIFIED = "architecture-compatible-but-unverified"
TIER_INCOMPATIBLE_ARCHITECTURE = "incompatible-architecture"
TIER_NO_MTP = "no-MTP"
TIER_AR_ONLY = "AR-only"

EXIT_VERIFIED = 0
EXIT_NO_MTP = 2
EXIT_UNVERIFIED = 3
EXIT_INCOMPATIBLE_ARCHITECTURE = 4
```

So the two verdicts a user can hit are distinguishable by exit code alone: **2** for a checkpoint
with no MTP head, **3** for one that is recognised but unverified, **4** for an architecture MTPLX
cannot load at all (which is what the config-only probes in the runtime-formats record hit).

### F5 — MTPLX refuses to attach a separately supplied MTP sidecar to an arbitrary MLX trunk [READ]

The README is explicit: "MTPLX does not support attaching a separately supplied MTP sidecar to an
arbitrary MLX trunk. Matching architecture fields, tensor shapes, or provenance labels cannot prove
that the head was trained against those exact trunk weights." So a third-party draft head cannot
be grafted on; the head must be trained by Forge against the exact trunk.

**Evidence:** `README.md`, "Forge: make your own MTP models" section, quoted verbatim.

### F6 — MiniCPM-V-4.7-1B has no native MTP head; its DSpark draft is a separate checkpoint meant for llama.cpp [READ]

The 1B's speculative-decoding partner is `openbmb/MiniCPM-V-4.7-1B-DSpark`: a standalone draft
checkpoint with 5 draft layers, 213,547,777 parameters, 15 draft tokens per forward pass, trained
against the 1B's own hidden-state layers [3, 7, 11, 15, 19], with a `-gguf` sibling for
llama.cpp. It is a separate model, not an MTP head inside the 1B, and the MiniCPM-V 4.7 cookbook
lists DSpark only under GGUF.

**Evidence:** `https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-DSpark/raw/main/README.md`
(specification table and training recipe);
`https://raw.githubusercontent.com/OpenSQZ/MiniCPM-V-CookBook/main/docs/pages/v4.7/overview.md`
line 114 ("Speculative decoding draft (GGUF)").

### F7 — mlx-vlm 0.7.9 ships DSpark drafters, but none for MiniCPM [READ]

The installed package has `speculative/drafters/` entries for deepseek_v4_dspark, deepseek_v4_mtp,
dflash2, dspark, eagle3, gemma4_assistant, gemma4_dflash, gemma4_dspark, gemma4_unified_assistant,
glm4_moe_lite_mtp, glm5_next_mtp, glm_moe_dsa_mtp, hy_v4_mtp, inkling_mtp, laguna_dflash,
muse_glimmer_assistant, nemotron_h_mtp, qwen3_5_mtp, qwen3_dflash, qwen3_dspark, qwen4_exp_mtp —
and nothing for MiniCPM. So the DSpark draft for MiniCPM-V 4.7 has no MLX consumer today, on
either runtime.

**Evidence:** directory listing of
`/tmp/mlxenv/lib/python3.15/site-packages/mlx_vlm/speculative/drafters/` (mlx-vlm 0.7.9 venv);
no entry matches "minicpm".

### F8 — mlx-vlm ships its own OpenAI-compatible server, so a local API does not require MTPLX [MEASURED]

`python -m mlx_vlm.server` exists in mlx-vlm 0.7.9 and takes `--model`, `--host`, `--port`,
`--image-model`, `--vision-cache-size`, `--min-pixels`/`--max-pixels`, `--kv-bits` and the usual
generation flags. Pointing it at the MLX conversion from the sibling record gives a local
OpenAI-style endpoint for a vision model.

**Evidence:** `python -m mlx_vlm.server --help` run in the mlx-vlm 0.7.9 venv (Python 3.15, Apple
M4) — options block printed above.

### F9 — `mtplx run` on the full MiniCPM-V MLX directory fails, even though `mtplx inspect` says it can run [MEASURED]

MTPLX was already installed on this machine (the app's runtime at
`/Applications/MTPLX.app`, CLI shim `~/.mtplx/bin/mtplx`, version 2.12.2), so this was tested
directly. `mtplx inspect --model /tmp/MiniCPM-V-4.7-1B-4bit --json` returns
`architecture_recognized: true`, `model_type: qwen3_5_text`, `can_run: true`, tier
`architecture-compatible-but-unverified`, `recommended_backend: qwen3_next` — and the message says
the model will be served autoregressively with `mtp_off`. The actual run then dies:

    ValueError: Model type minicpmv4_7 not supported.
    (mlx_lm/utils.py: importlib.import_module("mlx_lm.models.minicpmv4_7") -> ModuleNotFoundError)

The inspect verdict is optimistic: the backend's detection looks at the *text* tower
(`qwen3_5_text`) and the Qwen3-Next MTP markers, but the load path resolves the *outer*
`model_type` (`minicpmv4_7`) against mlx-lm's module registry, which has no such module.

**Evidence:** `mtplx inspect --model /tmp/MiniCPM-V-4.7-1B-4bit --json` (fields quoted above) and
`mtplx run --model /tmp/MiniCPM-V-4.7-1B-4bit --prompt "Reply with the single word: banana"
--max-tokens 24 --no-mtp` → exit 1, traceback ending `ValueError: Model type minicpmv4_7 not
supported.` (MTPLX 2.12.2, Apple M4 MacBook Air). The rejection comes from **mlx-lm 0.31.3**'s `mlx_lm/utils.py:185-191`, where the model class is
resolved from the config's `model_type` alone:

```python
model_type = config["model_type"]
model_type = MODEL_REMAPPING.get(model_type, model_type)
try:
    arch = importlib.import_module(f"mlx_lm.models.{model_type}")
except ImportError:
    msg = f"Model type {model_type} not supported."
    raise ValueError(msg)
```

MTPLX's loader sits one step
earlier: `mtplx/runtime.py:525-568` documents the fallback it provides for exactly this case —
"Alias `mlx_lm.models.<model_type>` to the module implementing the checkpoint's declared
architectures class, when mlx-lm has no module" — it builds `alias_name` from
`config["model_type"]` **or the text config's** `model_type` (`:542`), returns early when mlx-lm
already has a module for that name (`:549`), and then resolves the declared class through a table:
`ARCHITECTURE_DECLARED_MODULES` (`mtplx/backends/registry.py:1245-1252`), which lists only the
Qwen3.5 family —

    "Qwen3_5ForConditionalGeneration": "qwen3_5",   "Qwen3_5ForCausalLM": "qwen3_5",
    "Qwen3_5TextForCausalLM": "qwen3_5",              "Qwen3_5Moe*": "qwen3_5_moe"

MiniCPM's class (`MiniCPMV4_7ForConditionalGeneration`) is not in that table, so the fallback has
nothing to alias to — which is why the multimodal checkpoint is refused outright.

One detail worth knowing if you ever write such a config by hand: the alias installer matches the
declared class **case-sensitively** (`_ARCHITECTURE_DECLARED_MODULES.get(arch)`, `mtplx/runtime.py:558`),
whereas the registry's own resolution path uses a lowercased, dash-folded copy
(`_DECLARED_MODULES_LOWERED`, `mtplx/backends/registry.py:1254-1257`, consulted at `:1350`). So the
export's `architectures: ["Qwen3_5ForCausalLM"]` has to be spelled exactly that way for the alias
route to work — a lowercase spelling would not be aliased, even though the registry's path would
still recognise it.

### F10 — MiniCPM-V 4.7's text tower *is* a Qwen3.5 text model, and mlx-lm can load it [MEASURED]

The conversion's `config.json` carries `text_config.model_type = "qwen3_5_text"` (24 layers,
hidden 1024, gated-delta-net linear attention with periodic full attention), and the weight file
holds 513 `language_model.*` tensors next to 437 `vision_tower.*` and 22 merger tensors. mlx-lm's
own `qwen3_5` module has a matching `GatedDeltaNet` (`in_proj_qkv`, `in_proj_z`, `in_proj_b`,
`in_proj_a`, `A_log`, `conv1d`, `out_proj`, `norm`) and its `Model.sanitize` explicitly *skips*
`vision_tower.*` keys while passing `language_model.*` through unchanged. A text-only export
therefore loads in mlx-lm with no key surgery beyond dropping the vision and merger tensors.

**Evidence:** `/tmp/MiniCPM-V-4.7-1B-4bit/config.json` (`text_config.model_type = qwen3_5_text`);
tensor-prefix census of `model.safetensors` (language_model 513, vision_tower 437, merger 6,
vit_merger 16); **mlx-lm 0.31.3** in MTPLX's runtime venv, `mlx_lm/models/qwen3_5.py`:
`class GatedDeltaNet` at `:86`, and `Model.sanitize` at `:384` with the vision skip at `:387`
(`if key.startswith("vision_tower") or key.startswith("model.visual"): continue`); load succeeded
in 0.83 s.

A side effect worth knowing: because the export loads as mlx-lm's `qwen3_5` model, it lands in the
class of checkpoints MTPLX *optimises* rather than merely runs. MTPLX's runtime inspects the loaded
object and installs its Qwen3.5-specific paths when it matches (`mtplx/runtime.py:1133-1152`):

```python
try:
    from mlx_lm.models import qwen3_5 as _qwen3_5_module
    _inner_text = getattr(getattr(model, "language_model", model), "model", None)
    if isinstance(_inner_text, _qwen3_5_module.Qwen3_5TextModel):
        from .packed_concats import install_qwen3_next_packed_concats
        from .prefill_rungs import install_qwen3_5_prefill_rungs
        # Env-gated (MTPLX_PREFILL_ASYNC_RUNGS); no-op without a stride.
        install_qwen3_5_prefill_rungs()
        # Env-gated (MTPLX_PACKED_PROJ_CONCATS); no-op unless enabled.
        install_qwen3_next_packed_concats(model)
except ImportError:
    pass
```

The comment above it says it plainly: "dense Qwen3.8 loads as plain `qwen3_5`". A MiniCPM text
export is in the same class, so it gets the same treatment — and the two installs are env-gated
(`MTPLX_PREFILL_ASYNC_RUNGS`, `MTPLX_PACKED_PROJ_CONCATS`), so nothing changes unless those are
set.

### F11 — The text-only export runs inside MTPLX, autoregressively, at ~50-65 tok/s [MEASURED]

Export recipe: keep only the `language_model.*` tensors (972 → 513, 2666 MB → 1569 MB — the
source size re-measured 2026-10-20; see the MLX record's F20), and
replace `config.json` with `{"model_type": "qwen3_5", "architectures": ["Qwen3_5ForCausalLM"],
"text_config": <the original text_config>, "quantization": {"bits": 4, "group_size": 64, "mode":
"affine"}}`, keeping the tokenizer, generation config and chat template. With that directory,
`mtplx run` succeeds:

    [mtplx] profile=sustained mode=AR mtp_depth=0 tokens=32 tok_s=49.84
    [mtplx] profile=sustained mode=AR mtp_depth=0 tokens=32 tok_s=64.83

and with `--reasoning off` the answer is clean: "Hello. I am here to help." (59.56 tok/s). The
quantization survives the export — the 4-bit affine weights and their scales/biases are copied
verbatim.

**Evidence:** export performed with `mlx.core.load` / `mlx.core.save_safetensors` in the
mlx-vlm 0.7.9 venv into `/tmp/q35-textonly`; `mtplx run --model /tmp/q35-textonly --prompt "Say
hello in three words." --max-tokens 32` → exit 0 with the two tok/s figures above (Apple M4,
MTPLX 2.12.2, `--reasoning off` run printed "Hello. I am here to help." at 59.56 tok/s).

### F12 — What the export costs: no vision, no speculative decoding, and a thinking-mode mismatch [MEASURED]

The exported model is text-only — the 437 vision-tower tensors and the 22 merger tensors are
dropped, so it answers text prompts but has no image path. Speculative decoding is off
(`mtp_depth=0`, `mode=AR`): the checkpoint carries no MTP head, and MTPLX's own message says Forge
cannot create one. MTPLX also keeps the MiniCPM chat template, whose thinking block makes
`mtplx run` print the model's reasoning ("Hmm, the user wants a simple greeting…") as the answer
unless `--reasoning off` is passed. `mtplx inspect` still reports the export as
`architecture-compatible-but-unverified` with exit code 3, because the missing MTP head is the
only thing it flags.

**Evidence:** `mtplx inspect --model /tmp/q35-textonly --json` → `arch_id: qwen3-next-mtp`, `tier:
architecture-compatible-but-unverified`, `exit_code: 3`, `mtp_supported: no`, `can_run: true`;
the `mode=AR mtp_depth=0` lines in the F11 output; the reasoning-text output observed without
`--reasoning off`. — measured on an Apple M4 MacBook Air (macOS 27.0.1, MTPLX 2.12.2, mlx-lm 0.31.3).
### F13 — The export recipe is scripted and reproduces end to end [MEASURED]

The prose recipe in F11 was turned into a script and re-run from scratch into a clean directory
(`/tmp/q35-textonly2`, deleted first), then handed to MTPLX: kept 513 tensors, dropped 459
(vision + merger), 1496.6 MB on disk, and `mtplx run` answered "Hello. I am here to help." at
**64.36 tok/s** (`mode=AR mtp_depth=0`). The recipe is therefore reproducible, not a one-off
hand-edit.

```python
#!/usr/bin/env python3
"""Export a MiniCPM-V 4.7 MLX checkpoint as a text-only Qwen3.5 model MTPLX can load.

MTPLX's loader resolves the checkpoint's top-level `model_type` against mlx-lm's module
registry, so `minicpmv4_7` is rejected. MiniCPM-V 4.7's text tower is a Qwen3.5 text model
(`text_config.model_type == "qwen3_5_text"`), and mlx-lm's `qwen3_5` module matches it
tensor-for-tensor while its `Model.sanitize` skips `vision_tower.*`.

So: keep the `language_model.*` tensors, drop the vision/merger ones, and rewrite config.json
with `model_type: qwen3_5` and the original `text_config`.

Usage:
    python export_mtplx_textonly.py <src-mlx-dir> <dst-dir>

Requires: mlx (numpy is not needed; mx.load/mx.save_safetensors do the work).
"""

import json
import os
import shutil
import sys

import mlx.core as mx

KEEP_PREFIX = "language_model."
TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "generation_config.json",
    "chat_template.jinja",
)


def export(src: str, dst: str) -> None:
    os.makedirs(dst, exist_ok=True)

    config = json.load(open(os.path.join(src, "config.json")))
    text_config = config["text_config"]

    weights = mx.load(os.path.join(src, "model.safetensors"))
    kept = {k: v for k, v in weights.items() if k.startswith(KEEP_PREFIX)}
    dropped = len(weights) - len(kept)
    print(f"tensors: kept {len(kept)}, dropped {dropped} (vision/merger)")
    if not kept:
        raise SystemExit(f"no {KEEP_PREFIX} tensors in {src}")

    mx.save_safetensors(os.path.join(dst, "model.safetensors"), kept)

    quantization = config.get("quantization") or config.get("quantization_config")
    new_config = {
        "architectures": ["Qwen3_5ForCausalLM"],
        "model_type": "qwen3_5",
        "text_config": text_config,
        "dtype": config.get("dtype", "bfloat16"),
        "tie_word_embeddings": text_config.get("tie_word_embeddings", False),
    }
    if quantization:
        new_config["quantization"] = quantization
    for key in ("eos_token_id", "bos_token_id", "pad_token_id"):
        if key in config:
            new_config[key] = config[key]
    json.dump(new_config, open(os.path.join(dst, "config.json"), "w"), indent=2)

    for name in TOKENIZER_FILES:
        source = os.path.join(src, name)
        if os.path.exists(source):
            shutil.copy2(source, os.path.join(dst, name))

    print(f"wrote {dst}")
    print("next: mtplx run --model %s --prompt 'hi' --reasoning off" % dst)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    export(sys.argv[1], sys.argv[2])
```

The block above is the script verbatim, and it now lives in the repository at
`docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/export_mtplx_textonly.py`
(the copy that was run here was `/tmp/export_mtplx_textonly.py`, so the two can be diffed). Usage:
`python export_mtplx_textonly.py <src-mlx-dir> <dst-dir>` then
`mtplx run --model <dst-dir> --prompt 'hi' --reasoning off`.

**Evidence:** script run as
`/tmp/mlxenv/bin/python /tmp/export_mtplx_textonly.py /tmp/MiniCPM-V-4.7-1B-4bit
/tmp/q35-textonly2` → "tensors: kept 513, dropped 459"; then
`mtplx run --model /tmp/q35-textonly2 --prompt "Say hello in exactly three words." --max-tokens 48
--reasoning off` → exit 0, "Hello. I am here to help.", `[mtplx] profile=sustained mode=AR
mtp_depth=0 tokens=9 tok_s=64.36` (MTPLX 2.12.2, Apple M4).

### F14 — The exported model also works as an MTPLX *server*, on both API dialects [MEASURED]

`mtplx run` is the one-shot path; the path an agent integration actually uses is `mtplx serve`.
Starting `mtplx serve --model /tmp/q35-textonly --port 8123 --host 127.0.0.1 --no-auth` came up
healthy in 6 s and served:

- `GET /health` → `{"ok":true,"model":"q35-textonly","vision":{"enabled":false,...},"generation_mode":"ar"}`
- `GET /v1/models` → `{"id":"q35-textonly","capability":"chat","supports_vision":false,"modalities":{"input":["text"],"output":["text"]},"context_length":262144}`
- `POST /v1/chat/completions` → `"content":"Hello, world."` with the MiniCPM thinking separated into
  `reasoning_content` ("Hmm, the user wants a greeting in exactly three words…") and
  `completion_tokens_details.reasoning_tokens: 24`
- `POST /v1/messages` (Anthropic dialect) → a `thinking` block plus content, `stop_reason: max_tokens`

So the export is usable exactly as MTPLX's own models are — an OpenAI- or Anthropic-compatible
endpoint on localhost for OpenCode, Pi, Cline or Open WebUI — with the caveat that
`supports_vision` is false and the server reports `generation_mode: ar`.

**Evidence:** `mtplx serve --model /tmp/q35-textonly --port 8123 --host 127.0.0.1 --no-auth`
(backgrounded, log at `/tmp/mtplx_serve.log`); the four HTTP calls above via `curl`; the server was
stopped afterwards with `mtplx stop --port 8123` → "Stopped the MTPLX server on port 8123 (pid
99697, SIGTERM)" and `/health` then refused the connection. — measured on an Apple M4 MacBook Air (macOS 27.0.1, MTPLX 2.12.2, mlx-lm 0.31.3).
### F15 — The MiniCPM tokenizer triggers a transformers warning under MTPLX's runtime [MEASURED]

Every load prints: "The tokenizer you are loading from '…' with an incorrect regex pattern …
You should set the `fix_mistral_regex=True` flag". It is a warning, not an error, and generation
was correct in every run — but it is noise that a user will read as a problem.

**Evidence:** the warning line in the stderr of both the mlx-lm load and every `mtplx run`
invocation in this session. — measured on an Apple M4 MacBook Air (macOS 27.0.1, MTPLX 2.12.2, mlx-lm 0.31.3).
### F16 — `mtplx forge probe` on MiniCPM-V 4.7 returns the no-MTP verdict, and Forge cannot build it [MEASURED]

The code-read in F2 is now the executed behaviour, on both the source repo and the exported
directory:

    $ mtplx forge probe openbmb/MiniCPM-V-4.7-1B --json
    { "architecture_id": "qwen3-next-mtp", "architecture_recognized": true,
      "backend_status": "native-ar-only-missing-mtp", "forgeable": false,
      "has_mtp_weights": false, "source_format": "bf16_native",
      "estimated_size_bytes": 3242981613, "estimated_peak_gib": 4.08,
      "source_sha": "379f120c2ff3588e6e06559ec6b9ec15cc05114e",
      "verdict": "no_mtp_heads", "supported": false,
      "message": "Source has no MTP head, and Forge currently builds speculative MTP artifacts only;
                   it cannot create missing trained MTP weights. AR-only Forge conversion/quantization
                   is not supported yet. For runtime-compatible checkpoints, use mtplx run / mtplx serve
                   directly with MTP disabled (mtp_off)." }

The exported text-only directory probes the same way (`verdict: no_mtp_heads`, `forgeable: false`,
`estimated_peak_gib: 2.56`), so the export does not become Forge-able either — which is expected:
Forge's job is to *extract and package* an MTP head, and MiniCPM-V 4.7 has none to extract. The
probe's own `source_format: bf16_native` and size estimate (3.24 GB, 4.08 GiB peak) are the
cheapest statement of what Forge thinks it is looking at.

**Evidence:** `mtplx forge probe openbmb/MiniCPM-V-4.7-1B --json` and
`mtplx forge probe /tmp/recheck-out/MiniCPM-V-4.7-1B-textonly --json` (MTPLX 2.12.2, Apple M4,
2026-10-20), fields quoted above.

### F17 — The committed script reproduces the whole chain from a clean machine state [MEASURED]

After the earlier artifacts were deleted, the shipped script was run from scratch into a fresh
output directory: it created the venv, installed `mlx-vlm==0.7.9`, made the HF cache writable,
converted the bf16 checkpoint, produced the MTPLX text-only export, and generated a caption for
the checkpoint ("A yellow circle centered on a blue background features a red inverted triangle at
its base."). `mtplx run` on the freshly exported directory answered "Good morning, I'm here." at
51.14 tok/s. The recipe is self-contained: no state from the earlier session was needed.

**Evidence:** `VENV=/tmp/recheck-venv OUT_ROOT=/tmp/recheck-out FORMATS=bf16 bash
scripts/convert_minicpmv47.sh` (run from
`docs/work/2026-10-20-minicpmv-4-7-1b-kit/`) → outputs `MiniCPM-V-4.7-1B-bf16` (3.0 GB)
and `MiniCPM-V-4.7-1B-textonly` (1.9 GB) plus the caption; then `mtplx run --model
/tmp/recheck-out/MiniCPM-V-4.7-1B-textonly --prompt "Say hello in exactly three words."
--max-tokens 48 --reasoning off` → "Good morning, I'm here.", `[mtplx] profile=sustained mode=AR
mtp_depth=0 tokens=8 tok_s=51.14` (MTPLX 2.12.2, Apple M4).

### F18 — MTPLX's architecture catalogue: 26 architectures, 18 families, and only two fully verified MTP lanes [READ]

The registry in the upstream source is the authoritative list of what MTPLX can run and how.
Dumped from `mtplx/backends/registry.py` by importing the module and calling `to_dict()` on each
`ArchitectureSupport` (upstream `main`, fetched 2026-10-20), grouped by family and lane:

**Verified, with native MTP**

| arch_id | family | backend | support_level |
|---|---|---|---|
| `qwen3-next-mtp` | qwen | `qwen3_next` | verified-native |
| `gemma4-assistant-mtp` | gemma | `gemma4_assistant` | runtime-runnable-qa-pending |

**Experimental, native MTP (contract-gated)** — `deepseek-v3-mtp`, `glm-moe-dsa-mtp`,
`glm4-moe-mtp`, `glm4-moe-lite-mtp`, `hy-v3-mtp`, `mimo-mtp`, `nemotron-h-mtp`, `step3p5-mtp`,
`qwen4-next`.

**AR only (mlx-lm loader, no speculative decoding)** — `laguna-s-2.1-ar` (the only *verified* AR
entry), `llama-ar`, `lfm2-moe-ar`, `iquestcoder-ar`, `deepseek-v4`.

**Recognised, backend not built yet** — `ernie-mtp`, `exaone-moe-mtp`, `exaone4-5-mtp`,
`gemma-mtp`, `glm-ocr-mtp`, `longcat-flash-mtp`, `minimax-m2-mtp`, `pangu-ultra-moe-mtp`,
`deepseek-v4-mtp`, `generic-mtp` (all `support_level: recognized-backend-pending`).

Two things this makes concrete. First, `SUPPORTED_ARCH_IDS` (13 ids) is not the same as the
catalogue (26): the supported set is the verified/experimental subset, and the rest are
recognised shapes with no backend behind them. Second, MiniCPM-V 4.7's text tower lands in the
**qwen** family (`qwen3-next-mtp`, backend `qwen3_next`) purely because it is a Qwen3.5 text model
— which is why the *architecture* is accepted and only the missing MTP head is the blocker. It
also means the `llama-ar` lane (plain mlx-lm, AR only) is the lane a MiniCPM-V text export would
sit in if it were not already handled by the qwen3_next backend.

**Evidence:** upstream `https://codeload.github.com/youssofal/MTPLX/tar.gz/refs/heads/main`
unpacked locally; `mtplx/backends/registry.py` (`SUPPORTED_ARCH_IDS` at lines 19-36,
`ARCHITECTURE_CATALOG` from line 131); the dump was produced by
`from mtplx.backends.registry import ARCHITECTURE_CATALOG` and printing
`to_dict()` per entry (family, backend, support_level, runtime_compatibility, can_run_verified).

### F19 — The MTP lane is closed for MiniCPM-V 4.7 on shape grounds as well as weight grounds [READ]

The registry maps `model_type: qwen3_5` onto the arch `qwen3-next-mtp` — its alias tuple is
`("qwen3_5_mtp", "qwen3_6_mtp", "qwen3-next", "qwen3_5")` — and the backend `qwen3_next` is an
*MTP* backend: it does not define weights, it calls `mtplx.runtime.load(..., mtp=True)`. So the
question that decides everything is whether MiniCPM-V 4.7's text tower has the same tensor layout
as the trunk an MTP head is trained against. It does not:

| trunk | linear-attention projections (mlx-lm 0.31.3) |
|---|---|
| Qwen3-Next (`mlx_lm/models/qwen3_next.py:200-203`) | fused `in_proj_qkvz` (→ `key_dim*2 + value_dim*2`) + `in_proj_ba` (→ `num_v_heads*2`) |
| Qwen3.5 (`mlx_lm/models/qwen3_5.py:114-120`) | separate `in_proj_qkv` (→ `key_dim*2 + value_dim`), `in_proj_z` (→ `value_dim`), `in_proj_b` and `in_proj_a` (→ `num_v_heads` each) |
| MiniCPM-V 4.7-1B (this model's checkpoint) | separate `linear_attn.in_proj_qkv` / `in_proj_z` / `in_proj_b` / `in_proj_a` |

The two families do not merely *name* their projections differently, they *split* them differently:
Qwen3-Next emits q, k, v and z from one matrix and b and a from another, Qwen3.5 emits q, k, v from
one matrix and z, b and a from three more. A checkpoint's parameter names therefore differ between
the families, which is the concrete reason a Qwen3-Next MTP head cannot be attached to a
Qwen3.5-shaped trunk.

The MiniCPM checkpoint is Qwen3.**5**-shaped, not Qwen3-Next-shaped — which is why the export
loads through mlx-lm's `qwen3_5` module and why `mtplx inspect` still names the Qwen3-Next MTP
backend. The consequence is sharper than "no head exists": even the *shape-compatible* head
family (Qwen3.5's own MTP) would be trained against different trunk weights, which is precisely
the failure MTPLX documents for a head that is not matched to its trunk — the model "still loads
and generates — with acceptance collapsed to a few percent". So the MTP lane is closed twice over
for this model: no head exists, and no foreign head would be meaningful.

**Evidence:** upstream `mtplx/backends/registry.py`, the `qwen3-next-mtp` entry (aliases,
`backend="qwen3_next"`, `family_gate="qwen-mtp-sidecar-or-embedded"`, references to
`mlx_lm/models/qwen3_next.py` and `qwen3_5.py`); `mtplx/backends/qwen3_next.py:21-31` (the backend
loads through `mtplx.runtime.load(..., mtp=True)`); **mlx-lm 0.31.3** in MTPLX's runtime venv —
`mlx_lm/models/qwen3_next.py:200` (`self.in_proj_qkvz = nn.Linear(`) and `:203`
(`self.in_proj_ba = …`) against `mlx_lm/models/qwen3_5.py:114` (`self.in_proj_qkv = nn.Linear(`),
`:117` (`in_proj_z`), `:118` (`in_proj_b`), `:119` (`in_proj_a`); and the converted checkpoint's own
tensor names, read from `model.safetensors` of the MiniCPM-V 4.7 MLX conversion
(`language_model.model.layers.N.linear_attn.in_proj_qkv|in_proj_z|in_proj_b|in_proj_a`).

### F20 — Architecture recognition is a substring match on the config's model_type, and the *text* config decides it [MEASURED]

`_detect_arch_id()` in the registry concatenates the checkpoint's `architectures` class name and its
`model_type` into one string and asks whether any catalogue alias is a **substring** of it. The
whole decision is three short functions (upstream `main`, lines 838-851):

```python
def _compact(value: str) -> str:
    return _text(value).replace("_", "").replace(" ", "")

def _alias_matches(combined: str, alias: str) -> bool:
    alias_text = _text(alias)
    if not alias_text:
        return False
    return alias_text in combined or _compact(alias_text) in _compact(combined)

def _support_alias_matches(support: ArchitectureSupport, combined: str) -> bool:
    aliases = (support.arch_id, *support.aliases)
    return any(_alias_matches(combined, alias) for alias in aliases)
```

So a match is a plain substring test on the lowercased text, with a second attempt that strips `_`
and spaces from both sides. The detector that uses them (`mtplx/backends/registry.py:854-866`)
starts like this:

```python
def _detect_arch_id(inspection: Any) -> str | None:
    architecture = _text(getattr(inspection, "architecture", None))
    model_type = _text(getattr(inspection, "model_type", None))
    combined = f"{architecture} {model_type}"
    has_config_mtp = int(getattr(inspection, "mtp_num_hidden_layers", 0) or 0) > 0
    has_explicit_mtp = has_config_mtp or "mtp" in combined or "nextn" in combined

    qwen_support = ARCHITECTURE_CATALOG["qwen3-next-mtp"]
    if _support_alias_matches(qwen_support, combined):
        return "qwen3-next-mtp"
```

The qwen3-next-mtp row is checked first and needs no MTP marker, and its aliases include
`qwen3_5` — so a config whose *text* `model_type` is `qwen3_5_text` is recognised as Qwen3-Next
however the outer config is labelled. Note also what `combined` is made of: the *architecture class
name* and the *model_type*, which is why the text config's type is what decides (the inspector
reports the text tower's `model_type` as the checkpoint's).

Four config-only probes make the rule visible (same config, one field changed each time; the
directories hold only `config.json`, so every verdict is about recognition, not weights):

| outer `model_type` | `architectures` | text `model_type` | arch_id | recognized | tier |
|---|---|---|---|---|---|
| `qwen3_5` | `Qwen3_5ForCausalLM` | `qwen3_5_text` | `qwen3-next-mtp` | **true** | architecture-compatible-but-unverified |
| `minicpmv4_7` | `MiniCPMV4_7ForConditionalGeneration` | `minicpmv4_7_text` | `generic-mtp` | **false** | **incompatible-architecture** (exit 4) |
| `minicpmv4_7` | `MiniCPMV4_7ForConditionalGeneration` | `qwen3_5_text` | `qwen3-next-mtp` | **true** | architecture-compatible-but-unverified |
| `llama` | `LlamaForCausalLM` | `qwen3_5_text` | `qwen3-next-mtp` | **true** | architecture-compatible-but-unverified |

Row 2 is the model as it is published, with the text tower renamed to match its own type: it is
**not** recognised, and it lands on a worse verdict than "no MTP" — `incompatible-architecture`,
"this MTPLX build ships no MLX implementation of the trunk and cannot attach this family". Row 3
is the same file with the text type left as `qwen3_5_text` (what the checkpoint actually ships):
recognised. Row 4 renames the outer config to llama and is *still* recognised, because the
matching string comes from the text config.

So the export's `model_type: "qwen3_5"` is not cosmetic: it is the field that makes both the
recognition and the loader (mlx-lm has `mlx_lm.models.qwen3_5`) resolve, and it is the *text*
tower's type, not the model's, that MTPLX reads.

The export also has a second, independent route to loadability, which the rewrite does not rely
on: its `architectures: ["Qwen3_5ForCausalLM"]` is one of the six entries in MTPLX's
`ARCHITECTURE_DECLARED_MODULES` table (`mtplx/backends/registry.py:1245-1252`). If mlx-lm ever
stopped shipping `mlx_lm.models.qwen3_5`, the declared-architecture alias would still find it.
(MiniCPM's own class is absent from that table — the mirror image of the problem F9 describes.)

**Evidence:** upstream `main`, fetched 2026-10-20 —
`mtplx/backends/registry.py:838-851` (`_compact`, `_alias_matches`, `_support_alias_matches`) and
`:854-896` (`_detect_arch_id`, including the qwen-first ordering and the `has_explicit_mtp` rule);
the chain that reaches a user-visible verdict: `registry.py:1476` calls
`detected_arch_id = _detect_arch_id(inspection)`, and `mtplx/artifacts.py:656` is where the
field is published (`"architecture_recognized": self.compatibility.get("recognized", False)`);
probes built from
`https://huggingface.co/openbmb/MiniCPM-V-4.7-1B/raw/main/config.json` with one field changed
each, then `mtplx inspect --model /tmp/archprobe/<dir> --json` (MTPLX 2.12.2, Apple M4, 2026-10-20);
the `arch_id` / `recognized` / `tier` values in the table are that command's output.

### F21 — `mtplx tune` cannot measure an AR-only model at all — not even its AR baseline [MEASURED]

The tuner is the one MTPLX command a user would reach for next, and it fails hard on a model
without an MTP head. `mtplx tune --model <export> --max-tokens 48 --json --no-save` exits 1 with
every candidate failing:

    results: [{mode: "AR",  error: "candidate did not write an artifact", returncode: 1},
              {mode: "D1", depth: 1, …}, {mode: "D2", …}, {mode: "D3", …}]
    best_multiplier: {"ar_tok_s": null, "available": false, "verdict": "tune_failed_no_ar_result"}
    saved: false, save_skipped_reason: "tune failed; no candidate produced usable tokens"

The candidate logs name the cause: each candidate is a subprocess that calls
`run_mtp_depth_sweep` → `load(model_path, mtp=True)`, and with no MTP head to inject the load
raises

    RuntimeError: MTP injection failed for /tmp/…/MiniCPM-V-4.7-1B-textonly
    (mtplx/runtime.py:819, raised from mtplx/benchmarks/runners/mtp_depth_sweep.py:153)

So the AR row fails for the same reason as the draft rows: the sweep always loads with MTP
injection on. `mtplx run` and `mtplx serve` do not (they take the `mtp_off` path), which is why
they work on the very same directory. Practical rule: **on an AR-only model, skip the tuner** —
there is no depth to choose, and MTPLX's own onboarding auto-tune would hit the same wall.

The run also records the runtime MTPLX actually uses, which is why the export loads at all:
**mtplx 2.12.2, mlx 0.32.2, mlx_lm 0.31.3, Python 3.14.5** — mlx-lm 0.31.3 ships
`mlx_lm.models.qwen3_5`, the module the export's `model_type` points at.

**Evidence:** `mtplx tune --model /tmp/tune-out/MiniCPM-V-4.7-1B-textonly --max-tokens 48 --json
--no-save` (MTPLX 2.12.2, Apple M4, 2026-10-20) → the JSON fields quoted above; the candidate
logs under `/private/tmp/outputs/cli/tune/tune-<timestamp>/ar.log` and `d1.log` with the traceback
quoted above; the `software` block of the same JSON for the runtime versions.

### F22 — Every MTPLX command, tried against the exported model [MEASURED]

The command surface was walked end to end on the text-only export, so "can I use this model with
MTPLX" has a per-command answer rather than a general one:

| command | on the export |
|---|---|
| `mtplx run --model <export> --prompt …` | **works** — exit 0, 47-65 tok/s (F11) |
| `mtplx serve --model <export> --port …` | **works** — server up; `/v1/chat/completions`, `/v1/messages`, `/v1/models` all answer (F14) |
| `mtplx quickstart --model <export> --port …` | **works** — server up in ~2 s, the OpenAI route answers (measured here) |
| `mtplx ask --model <export> --prompt …` | **works** — but the model's thinking block is printed as the answer, and the closing `</think>` tag comes out literally |
| `mtplx chat --model <export> --prompt …` | **prints the right answer and exits 4** (incompatible-architecture) — do not trust the exit code |
| `mtplx inspect --model <export> --json` | **works** — `architecture-compatible-but-unverified`, `mtp_off` (F9) |
| `mtplx forge probe <export> --json` | **works** — `no_mtp_heads`, `forgeable: false` (F16) |
| `mtplx forge build <export>` | **refused** — no MTP head to package (F2, F16) |
| `mtplx tune --model <export>` | **fails** — `MTP injection failed`, AR baseline included (F21) |
| `mtplx models` | lists only the model cache (`~/.mtplx/models`); an export at a `/tmp` path is not listed, so put it in the cache if you want it discoverable |
| `mtplx quickstart` (without `--model`) | **fails here** — it uses the *configured* model: "model is not available locally … Run: mtplx pull …" |

The practical read: the model is usable in MTPLX as a **server** (`serve` / `quickstart --model`)
and as a one-shot (`run`, `ask`), it is *inspectable* but not *forgeable* and not *tunable*, and
`chat` is a trap for scripts because it answers correctly while reporting failure.

**Evidence:** each row run on 2026-10-20 against `/tmp/cmd-out/MiniCPM-V-4.7-1B-textonly` (MTPLX
2.12.2, Apple M4): `mtplx run` exit 0; `mtplx serve` and `mtplx quickstart --model … --port 8401`
both healthy with an OpenAI completion returned; `mtplx ask` printing "Hello there!" after the
thinking block; `mtplx chat` printing the same text and exiting 4; `mtplx inspect` and
`mtplx forge probe` returning the JSON quoted in F9/F16; `mtplx tune` failing as in F21;
`mtplx models` listing the two cached catalog models; `mtplx quickstart` (no `--model`) printing
"error: model is not available locally / model: Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed".

### F23 — A small `max_tokens` yields an empty `content` because the thinking block eats the budget [MEASURED]

The MiniCPM chat template emits a `<think>` block before the answer. Through the server that
thinking is returned separately as `reasoning_content` — but it is generated first and counts
against the token budget, so a small cap leaves nothing for the answer:

    POST /v1/chat/completions  {"max_tokens": 24, …}
    → {"choices":[{"message":{"role":"assistant","content":"","reasoning_content":"Hmm, the user wants a
       simple greeting in exactly three words. Let's keep it concise. \"Hello, I'm"},"finish_reason":"length"}],
       "usage":{"completion_tokens":24}, "mtplx_stats":{"tok_s":46.99,"end_to_end_tok_s":38.39}}

`content` is the empty string, `finish_reason` is `length`, and the answer never appears. The same
run with a larger budget (or `--reasoning off` on the CLI) returns the text normally. Worth
knowing before concluding that the server is broken: **give a vision model enough token budget for
its reasoning, or turn reasoning off.**

**Evidence:** `mtplx quickstart --model <export> --port 8401` then `POST /v1/chat/completions` with
`max_tokens: 24` (MTPLX 2.12.2, Apple M4, 2026-10-20) — the response quoted above, with
`text_preview` in the server log echoing the same reasoning-only text.

### F24 — Forge classifies the artifacts this project's script produces as `mlx_affine` / `bf16_native` — the format is never the blocker [MEASURED]

Forge's source classifier is config-driven, and every artifact the shipped script produces lands
on a *supported* source format. The classifier's order is: runtime metadata → `mtp.safetensors`
present → autoawq → compressed-tensors nvfp4 → compressed-tensors awq → **any quantization block
present** → MTP declared → `hf_vllm` → `unknown`. The nine recognised source formats are
`bf16_native`, `mlx_affine`, `mlx_affine_with_mtp`, `autoawq`, `compressed_tensors_awq`,
`compressed_tensors_nvfp4`, `gemma4_assistant_pair`, `hf_vllm` and `unknown`.

Measured on the artifacts:

| directory | `source_format` | `forgeable` | `verdict` | estimated size |
|---|---|---|---|---|
| `openbmb/MiniCPM-V-4.7-1B` (HF repo) | `bf16_native` | false | `no_mtp_heads` | 3.24 GB |
| bf16 export (no quantization block) | `bf16_native` | false | `no_mtp_heads` | 2.03 GB |
| affine-4bit export (`quantization: {group_size: 64, bits: 4, mode: "affine"}`) | **`mlx_affine`** | false | `no_mtp_heads` | 1.59 GB |
| affine-4bit MLX checkpoint (pre-export) | `mlx_affine` | false | `no_mtp_heads` | 2.80 GB |

So the conversion work this project does produces exactly the format Forge wants — an MLX
safetensors directory with a quantization block it recognises — and the *only* thing Forge refuses
is the missing MTP head. That closes the question "would a converted MiniCPM be a valid Forge
input?" with a precise no: **the format is right, the head is not there, and a head cannot be
manufactured** (F2, F16, F19).

**Evidence:** `mtplx/commands/forge.py:45-64` (the `SOURCE_*` constants and
`SUPPORTED_SOURCE_FORMATS`) and the `_source_format_from_config` function (the branch order
quoted above); probes via `mtplx forge probe <dir> --json` for the two export directories and the
HF repo (MTPLX 2.12.2, Apple M4, 2026-10-20), values in the table.

### F25 — The export's weights match mlx-lm's `qwen3_5` module exactly; the ignored config keys are no-ops bar one [MEASURED]

Two things had to be true for the text-only export to be *correct*, not merely loadable: the
weight names must match mlx-lm's `qwen3_5` module one for one, and no config field that changes
the architecture may be silently dropped. Both hold.

**The weights.** mlx-lm's loader is strict, and the loader's own key filter is what makes the
export work. `mlx_lm/models/qwen3_5.py:384-398` (mlx-lm 0.31.3):

```python
def sanitize(self, weights):
    sanitized = {}
    for key, value in weights.items():
        if key.startswith("vision_tower") or key.startswith("model.visual"):
            continue
        if key.startswith("model.visual"):
            continue
        if key.startswith("model.language_model"):
            key = key.replace("model.language_model", "language_model.model")
        elif key.startswith("language_model."):
            pass
        else:
            key = "language_model." + key
        sanitized[key] = value
    return self.language_model.sanitize(sanitized)
```

Two things follow. The vision tower is **dropped by the loader itself** (the `vision_tower` /
`model.visual` branches), and a key that is neither `model.language_model…` nor `language_model.…`
gets the `language_model.` prefix — which is why the `merger.*` and `vit_merger.*` tensors do not
survive: they would be renamed to `language_model.merger.…` and then rejected. That rejection is
what the first export attempt hit — `ValueError: Received 22 parameters not in model:
language_model.merger.mlp.0.linear_1.bias, …` — and dropping them made the load succeed, which is
the proof that the remaining 513 tensors are exactly the module's parameter set: no missing
weights, no extras.

**The config.** mlx-lm 0.31.3's `qwen3_5.TextModelArgs` — `@dataclass` at
`mlx_lm/models/qwen3_5.py:24`, `class TextModelArgs(BaseModelArgs):` at `:25`, its fields from
`:26` to `:83` (MTPLX's runtime venv) — consumes `hidden_size`,
`intermediate_size`, `num_hidden_layers`, `num_attention_heads`, `rms_norm_eps`, `vocab_size`,
`num_key_value_heads`, `max_position_embeddings`, the six `linear_*` sizes, `tie_word_embeddings`,
`attention_bias`, `head_dim`, `full_attention_interval`, the MoE fields, `rope_parameters`,
`partial_rotary_factor`, `rope_theta` and `rope_scaling`. The MiniCPM-V 4.7 `text_config` keys it
does **not** consume are:

| dropped key | value | effect |
|---|---|---|
| `layer_types` | `[linear×3, full, linear×3, full, …]` | none — mlx-lm derives the same pattern from `full_attention_interval: 4` |
| `hidden_act` | `silu` | none — mlx-lm's Qwen3.5 MLP is SwiGLU/silu by construction |
| `attn_output_gate` | `true` | none — the attention variant is implied by the module, and the gate weights are present in the checkpoint (the strict load would have failed otherwise) |
| `mlp_only_layers` | `[]` | none — empty list |
| `initializer_range`, `attention_dropout` | `0.02`, `0.0` | none — training-time / dropout-only |
| `mtp_num_hidden_layers`, `mtp_use_dedicated_embeddings` | `1`, `false` | none — MTP is not in the trunk |
| **`mamba_ssm_dtype`** | `float32` | **the one caveat** — MiniCPM's SSM state is fp32; mlx-lm's `qwen3_5` keeps `A_log`/`dt_bias` at the checkpoint's dtype (the `cast_predicate` keeps `A_log` in source precision), so the linear-attention path may differ in the last bits from the reference stack |

So the export is a faithful trunk, with one numerical difference worth naming if exactness against
the transformers reference matters to you: the SSM precision convention.

**Evidence:** mlx-lm 0.31.3 in MTPLX's runtime venv —
`…/mlx_lm/models/qwen3_5.py`: `@dataclass` at `:24` and `class TextModelArgs(BaseModelArgs):` at
`:25`, its fields from `:26` to `:83` (`rope_scaling` at `:83`), `Model.sanitize` at `:384-398`
(quoted above), and the cast rule at `:346-352` and `:530-531`:

```python
def cast_predicate(self):
    def predicate(path: str):
        if path.endswith("A_log"):
            return False
        return True
    return predicate
```

so `A_log` — the SSM decay term, the one tensor whose precision decides the linear-attention
numerics — is the **only** parameter excluded from the cast to the model's dtype, which is why the
source's `mamba_ssm_dtype: float32` caveat is a real one and not a non-issue; the
MiniCPM `text_config` from `https://huggingface.co/openbmb/MiniCPM-V-4.7-1B/raw/main/config.json`;
the strict-loader failure quoted above, observed while building this export (the 22
`merger`/`vit_merger` tensors), and the successful load after dropping them.

### F26 — The export is immune to the double-norm-shift trap, and the immunity is measurable [MEASURED]

MTPLX's own compatibility note warns that mlx-lm's qwen3.5-family loader "keys its +1.0
delta-norm restoration on the bare presence of those keys, so it shifts every trunk RMSNorm of an
already-absolute checkpoint a second time. The model still loads and generates — with acceptance
collapsed to a few percent". That is a silent-corruption failure mode, and the export sits right
next to it: mlx-lm's `qwen3_5.sanitize` shifts every norm by `+1.0` when
`has_mtp_weights or has_unsanitized_conv1d`, where the second condition is
`any("conv1d.weight" in k and v.shape[-1] != 1)`.

Measured on the export, neither condition fires:

| guard | value in the export | fires? |
|---|---|---|
| `has_mtp_weights` — any `mtp.*` key | **0** such keys in the file | no |
| `has_unsanitized_conv1d` — `conv1d.weight` with `shape[-1] != 1` | `(6144, 4, 1)` — `shape[-1] == 1` | no |

And the consequence is verified numerically rather than argued: loading the export with
`mlx_lm.load` and comparing every norm tensor in the loaded module against the file gives
**61 tensors compared, max |loaded − file| = 0.000000** — bit-identical, no shift. The stored norms
are absolute scales (input-layernorm means 1.09-1.43, max 2.0), which is the convention mlx-lm
expects precisely when it does *not* shift.

The practical rule this yields for the export recipe: **the `conv1d` layout and the absence of
`mtp.*` keys are load-bearing**. An export whose `linear_attn.conv1d.weight` arrived as
`[d, 1, k]`, or that carried `mtp.*` tensors, would trigger the shift and every RMSNorm in the
trunk would be off by +1.0 — a model that still loads and still answers, with quietly wrong
numbers.

**Evidence:** mlx-lm 0.31.3 in MTPLX's runtime venv,
`mlx_lm/models/qwen3_5.py` (`sanitize`: `has_mtp_weights`, `has_unsanitized_conv1d`,
`should_shift_norm_weights`, the `+1.0` norm shift and the `conv1d` moveaxis); the export
directory's `model.safetensors` read with `mx.load` (0 `mtp.*` keys; `conv1d.weight` shape
`(6144, 4, 1)`); and the load-and-compare run: `mlx_lm.load(<export>)` then
`mlx.utils.tree_flatten(model.parameters())` compared key-by-key against the file — 61 norm
tensors, max |delta| 0.000000 (a +1.0 shift would have shown 1.0).

### F27 — The text-only export is the only mlx-lm-family route for MiniCPM-V 4.7 — the reason is architectural [INFERRED]

A synthesis of findings rather than a new observation. It reasons from: F9 (MTPLX's loader resolves
the checkpoint's top-level `model_type` against mlx-lm's module registry, so `minicpmv4_7` is
refused outright), F20 (recognition is a substring match on the config strings, so the *text*
tower's `model_type` is what decides), F19 (MiniCPM's trunk is Qwen3.**5**-shaped — separate
`in_proj_qkv`/`z`/`b`/`a` — not Qwen3-Next-shaped, so no Qwen3-Next MTP head can be grafted on),
and F25 (the export's tensor set matches mlx-lm's `qwen3_5` module exactly, with the strict
loader as the proof).

From those, the conclusion: because the trunk is Qwen3.5-shaped rather than llama-shaped, the
*only* mlx-lm-family route for this model is the export — a text-tower-only checkpoint that
declares `model_type: qwen3_5` — and that route necessarily costs the vision tower. A llama-shaped
MiniCPM would have landed in MTPLX's `llama-ar` lane instead, text-only but with no `qwen3_5`
aliasing trick needed. So the trade is fixed by the architecture, not by the tooling: **text only,
or nothing**.

**Reasoning from:** F9, F19, F20 and F25 as above. Nothing here was executed as a whole; each
premise was measured or read separately.

## Still open

- Whether a vision-capable MiniCPM-V 4.7 could ever run under MTPLX: it would need the
  `minicpmv4_7` loader plus MiniCPM's own vision tower (SigLIP-style, with its `merger` and
  `vit_merger` modules) ported into `mtplx/`, which does not exist today — MTPLX's vision code is
  ported for the Qwen3-VL tower and Gemma 4 only. The text-only export in F11/F13 is the reachable
  version of "MiniCPM in MTPLX".
- Whether the 5-layer DSpark draft (F6) could be ported to an mlx-vlm drafter, which would give
  MiniCPM-V 4.7 exact speculative decoding on MLX — MTPLX would still not use it, because
  MTPLX only accepts heads it built itself against the exact trunk.
- Whether an MTP head could be *trained* for MiniCPM-V 4.7's text tower rather than extracted —
  Forge will not create missing heads (F2, F16), and MTPLX refuses third-party sidecars on an
  arbitrary trunk (F5), so this would mean writing the training and the loader support
  upstream rather than running a command.
- Whether MTPLX's app has a "load any local MLX directory" flow distinct from the catalog; the
  CLI's `run`/`serve` accept a path (F11, F14), the app's onboarding was not exercised.
- Whether the exported text-only model is worth its quirks for real work: this session measured
  load and a one-line answer, not a benchmark, and the tokenizer's regex warning (F15) was
  accepted as-is.
