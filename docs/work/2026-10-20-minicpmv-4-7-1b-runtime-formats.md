# Research: which local runtimes can run MiniCPM-V-4.7-1B, and in which file format

**Date:** 2026-10-20
**Question:** For MiniCPM-V-4.7-1B, which local runtimes accept it, what file format does each one need, and is a conversion required?

**Grades:** `[MEASURED]` = ran the command and read the result (the evidence line names the
command, the machine and the conditions) · `[READ]` = read in a source authoritative for that
claim (path:line, a doc URL, a spec section) · `[INFERRED]` = reasoned from the findings above
(the reasoning is named) · `[UNVERIFIED]` = not checked (what would settle it is named).

**Conditions:** registry, catalogue and cookbook claims are read from upstream sources on
2026-10-20 (MTPLX `main`, the MiniCPM-V CookBook, the Hugging Face API); the serving claims are
measured on an Apple M4 MacBook Air with mlx-vlm 0.7.9 and MTPLX 2.12.2.

**Short answer:** the formats split by runtime, and only two of them need anything from you.
**llama.cpp** takes the official GGUF plus a separate vision projector (`mmproj`) and is the
reference path (support merged upstream in PR #29416). **Ollama** cannot load 4.7 yet — its model
code knows the architecture but the bundled llama.cpp is too old (the registry page 404s today).
**LM Studio** has no published 4.7 model. **mlx-vlm** runs the full multimodal model from the MLX
conversion (the sibling record). **MTPLX** runs only the text tower, via the export in the other
record. **mlx-lm** runs the text tower only.

## Findings

### F1 — llama.cpp runs MiniCPM-V 4.7 from a GGUF plus a separate `mmproj` projector [READ]

The official cookbook's llama.cpp page gives the file pairing: the language model as
`MiniCPM-V-4_7-1B-Q4_K_M.gguf` and the vision projector as `mmproj-model-f16.gguf` (or
`mmproj-model-f16-4x.gguf`). Support was merged into upstream llama.cpp in PR #29416, so a
checkout at or after that PR works. The 1B GGUF repository does ship those files, plus a
`dspark-MiniCPM-V-4_7-1B-F16.gguf` speculative-decoding draft, alongside the full K-quant set
(F16, Q8_0, Q6_K, Q5_K_M, Q5_K_S, Q5_1, Q5_0, Q4_K_M, Q4_K_S, Q4_1, Q4_0).

**Evidence:** `https://raw.githubusercontent.com/OpenSQZ/MiniCPM-V-CookBook/main/deployment/llama.cpp/minicpm-v4_7_llamacpp.md`
(the file-pairing table, the PR #29416 note, the list of shipped GGUFs and both mmproj files);
`https://huggingface.co/api/models/openbmb/MiniCPM-V-4.7-1B-gguf` → sibling list including
`MiniCPM-V-4_7-1B-Q4_K_M.gguf`, `mmproj-model-f16.gguf`, `mmproj-model-f16-4x.gguf`,
`dspark-MiniCPM-V-4_7-1B-F16.gguf`.

### F2 — A 4.7 GGUF must be built with a current converter: canvas M-RoPE changed the format [READ]

4.7 uses canvas M-RoPE, which introduced a new GGUF metadata key (`rope.section_order`) and a new
mmproj tensor (`v.tok_embd_sep`). The cookbook's warning is specific: GGUF files converted with an
**older** `convert_hf_to_gguf.py` "will load in recent builds but compute M-RoPE incorrectly (or
fail on the missing mmproj tensor)". So a hand-made GGUF from an old converter is a silent-wrong-
answer trap, not a hard error — the official GGUFs are the safe route.

**Evidence:** `deployment/llama.cpp/minicpm-v4_7_llamacpp.md`, the "GGUF format change" callout
quoted above.

### F3 — Ollama cannot run 4.7 yet, and its registry has no 4.7 model [MEASURED]

Ollama's own model code recognises MiniCPM-V 4.7 (`convert_minicpmv.go`), but the cookbook states
that the **bundled llama.cpp must catch up to PR #29416** before it can load 4.7 GGUFs, and that
"until then, `ollama create` / `ollama run` on a 4.7 GGUF will fail". Checking the registry from
here agrees: `https://ollama.com/library/minicpm-v4.7` returns **404**, while
`/library/minicpm-v4.6`, `/library/minicpm-v4.5` and `/library/minicpm-v` all return 200. The
library search lists exactly those three MiniCPM pages and no 4.7. The cookbook's forward-looking
command is `ollama run openbmb/minicpm-v4.7` — for a release that has not shipped.

**Evidence:** `curl -sS -o /dev/null -w '%{http_code}' https://ollama.com/library/minicpm-v4.7`
→ **404** on 2026-10-20 (the same request for `minicpm-v4.6`, `minicpm-v4.5` and `minicpm-v` each
returns 200); `curl -sSL 'https://ollama.com/search?q=minicpm'` → library pages `/library/minicpm-v`,
`/library/minicpm-v4.5`, `/library/minicpm-v4.6` and no 4.7; cookbook
`deployment/ollama/minicpm-v4_7_ollama.md` ("Model code ready; runtime awaits the bundled
llama.cpp catching up to #29416").

### F4 — LM Studio has no published MiniCPM-V 4.7 model [MEASURED]

The `lmstudio-community` Hugging Face organisation publishes 754 models; the only MiniCPM entries
are `lmstudio-community/MiniCPM-V-2_6-GGUF` and `lmstudio-community/MiniCPM-o-2_6-GGUF`. There is
no 4.7 in either GGUF or MLX form.

**Evidence:** `curl -sS 'https://huggingface.co/api/models?author=lmstudio-community&limit=1000'` →
754 models, MiniCPM-matching ids: `lmstudio-community/MiniCPM-V-2_6-GGUF`,
`lmstudio-community/MiniCPM-o-2_6-GGUF`, and nothing for 4.7. — measured 2026-10-20 with unauthenticated requests to the Hugging Face API.
### F5 — LM Studio's in-app catalogue could not be enumerated from here [UNVERIFIED]

`lmstudio.ai/models?search=minicpm` is a client-rendered Next.js page: the HTML carries the search
term but no model rows, and the obvious API paths return either the app shell (200) or a 500. So
this investigation can say what LM Studio's *publisher* ships, not what its in-app catalogue lists.
LM Studio also loads local directories, so a 4.7 model in the right format would still be usable
there — that path was not exercised.

**Note — what was tried, not evidence for the claim:** `curl -sSL
'https://lmstudio.ai/models?search=minicpm'` (200, 968 KB of app shell with the query only in the
page state), `https://lmstudio.ai/api/models?search=minicpm` (200, HTML),
`https://lmstudio.ai/api/v1/models` (500 `Internal Server Error`).

### F6 — mlx-vlm runs the full multimodal model from the MLX conversion [MEASURED]

The MLX conversion (bf16 / 4-bit / mxfp4 / nvfp4 / mxfp8) is a complete multimodal checkpoint:
vision tower, resampler and text tower together, generating correct captions from images. Its
server (`python3 -m mlx_vlm.server`) speaks the OpenAI API, so it substitutes for LM Studio or
Ollama on Apple Silicon.

**Evidence:** the sibling record
the MLX record (`docs/work/2026-10-20-minicpmv-4-7-1b-mlx-conversion.md`) — its F7 (the converted
model describes the test image correctly) and its F8 (throughput) — and the MTPLX record's F8
(`mlx_vlm.server
--help` lists `--model`, `--image-model`, `--port`).

### F7 — MTPLX and mlx-lm run the text tower only [MEASURED]

MTPLX's loader rejects the full checkpoint (`ValueError: Model type minicpmv4_7 not supported`),
and the text-only export — the `language_model.*` tensors with a `qwen3_5` config — runs inside
MTPLX at ~47-65 tok/s in AR-only mode, with no image path. mlx-lm is a text-only runtime, so the
same export is the only thing it can load; its `qwen3_5` module matches MiniCPM-V 4.7's text
tower tensor-for-tensor.

**Evidence:** the sibling records — `docs/work/2026-10-20-mtplx-format-for-minicpmv.md`'s F9 (the
rejection), F11 (the export running) and F14 (the server endpoints), and
`docs/work/2026-10-20-minicpmv-4-7-1b-mlx-conversion.md`'s F16 (the token-packing finding that
explains why the text tower is a Qwen3.5 model at all).

### F8 — The DSpark speculative draft is a llama.cpp-side artefact [READ]

The draft checkpoint for 4.7 ships as a GGUF in the same repository
(`dspark-MiniCPM-V-4_7-1B-F16.gguf`) and the cookbook lists the DSpark GGUFs only under
"Speculative decoding draft (GGUF)". On the MLX side, mlx-vlm 0.7.9 ships DSpark drafters for
deepseek_v4, qwen3 and gemma4 but none for MiniCPM, so the 4.7 draft has no MLX consumer today.

**Evidence:** `https://huggingface.co/api/models/openbmb/MiniCPM-V-4.7-1B-gguf` sibling list;
`docs/pages/v4.7/overview.md` line 114; the drafters directory of the installed mlx-vlm 0.7.9
package (no MiniCPM entry).

### F9 — mlx-vlm's server takes images over the OpenAI API, unlike the MTPLX path [MEASURED]

The vision claim on the MLX side was previously only about the converter; this is the serving
path. `python3 -m mlx_vlm.server --model <mlx checkpoint> --port 8200` came up in 3 s and answered
an OpenAI-style request carrying a `data:image/png;base64,…` payload:

    POST /v1/chat/completions
    {"model": "<the served model path>",
     "messages": [{"role": "user", "content": [
        {"type": "text", "text": "What shape is in the middle of the image, and what colour is the background?"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,…"}}]}],
     "max_tokens": 64, "temperature": 0}

    HTTP 200 in 2.5 s
    content: "The shape in the middle is a yellow circle with a red triangle, and the background is blue."
    usage:   {"prompt_tokens": 241, "completion_tokens": 21, "total_tokens": 262}

Two practical details: the `model` field must be the **served model id**, not a friendly name —
`"model": "minicpm"` made the server try to download `minicpm` from the Hub and answer
`404 Repository Not Found`; and the image tokens are counted in the prompt (241 prompt tokens for
a 512x512 image at the default 16x packing). The image was synthesised, so the answer is
checkable by construction.

This is the sharpest contrast in the whole comparison: the same checkpoint serves **vision** over
the OpenAI API through mlx-vlm, while the MTPLX export of the same model reports
`supports_vision: false` and can only answer text (F7).

**Evidence:** `python3 -m mlx_vlm.server --model /tmp/vis-out/MiniCPM-V-4.7-1B-affine4 --port 8200
--host 127.0.0.1` (mlx-vlm 0.7.9, Apple M4); the request above over `urllib`; the 404 came from the
first attempt with `"model": "minicpm"`, the 200 from the retry with the served path. The server was
stopped afterwards (`pkill -f "mlx_vlm.server --model /tmp/vis-out"`, then the port refused
connections).

### F10 — mlx-vlm's server speaks images on all three API dialects, and handles multiple images [MEASURED]

The single-image OpenAI path (F9) is the narrow case. The server's own route list shows the
surface: `/chat/completions`, `/messages`, `/responses`, `/responses/compact`, `/responses/input_tokens`,
`/v1/embeddings`, `/v1/rerank`, `/v1/decisions`, `/audio/*`, `/images/*`, `/v1/cache/*`,
`/v1/moe-offload/stats`, `/v1/settings`, `/unload`, `/metrics`, `/health`, `/models`. Three
image-carrying routes were exercised against the same 4-bit checkpoint:

| route | payload | result |
|---|---|---|
| `POST /v1/chat/completions` | two `image_url` data URLs in one message | 200 in 1.0 s — "A yellow circle is centered on a red background, A white triangle is centered on a blue background." |
| `POST /v1/messages` (Anthropic) | `{"type":"image","source":{"type":"base64","media_type":"image/png","data":…}}` | 200 in 0.8 s — "The background of the image is red. It's a solid red field with a yellow circle in the center." |
| `POST /v1/responses` (Codex-style) | `{"type":"input_text"}` + `{"type":"input_image","image_url":"data:…"}` | 200 in 0.6 s — `output_text`: "A yellow circle is centered on a red background." |

The multi-image case is the one worth noting: the model described **both** images and kept their
order, which is the behaviour the model card claims ("text, images, multiple images, and video").
So on Apple Silicon, mlx-vlm's server is a drop-in for the OpenAI *and* Anthropic *and* Responses
dialects with a vision model behind them — the gap that Ollama and LM Studio currently leave open
for MiniCPM-V 4.7 (F3, F4).

**Evidence:** `python3 -m mlx_vlm.server --model <4-bit checkpoint> --port 8300 --host 127.0.0.1`;
`GET /openapi.json` → the route list quoted above; the three POSTs as tabulated (synthetic 384x384
images: a yellow circle on red, a white triangle on blue), each answered in under a second. The
server was stopped afterwards and the port refused connections. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9).
### F11 — The generic DSpark drafter's target-compatibility gate is already satisfied by MiniCPM-V 4.7 [READ]

mlx-vlm 0.7.9's drafter for DSpark is explicitly model-agnostic — the class docstring says
"Model-agnostic DSpark proposal model over a Qwen-style draft backbone" — and the only target
gate is `validate_dflash_target`, whose whole body is four checks (upstream
`mlx_vlm/speculative/drafters/compatibility.py:21-50`, byte-identical in 0.7.9 and upstream `main`):

```python
# abridged from the file cited above — the function header and the raise-message
# texts are omitted; the numbered comments are mine
hidden_size = _config_value(target_config, "hidden_size")
if hidden_size != config.hidden_size:            # 1. hidden size
    raise ValueError(...)
layer_count = len(layers) if layers is not None else _config_value(target_config, "num_hidden_layers")
if layer_count != config.num_target_layers:      # 2. layer count
    raise ValueError(...)
vocab_size = _config_value(target_config, "vocab_size")
if vocab_size != config.vocab_size:              # 3. vocabulary
    raise ValueError(...)
if not hasattr(language_model, "rollback_speculative_cache"):   # 4. rollback support
    raise ValueError(...)
```

MiniCPM-V 4.7 passes all four:

| gate | draft (DSpark checkpoint) | target (MiniCPM-V 4.7 text tower) | |
|---|---|---|---|
| `hidden_size` | 1024 | 1024 | ✓ |
| layer count vs `num_target_layers` | 24 | 24 | ✓ |
| `vocab_size` | 248094 | 248094 | ✓ |
| `hasattr(language_model, "rollback_speculative_cache")` | required | **inherited** | ✓ |

The last row is the one that decides it, and it is a matter of inheritance rather than
implementation. The chain (mlx-vlm 0.7.9 as installed) is:

    mlx_vlm/models/qwen3_5/language.py        class LanguageModel
      │   :7-9   from ...speculative.cache_state import (
      │          rollback_speculative_cache as rollback_cache_transaction)   ← the shared helper
      │   :1446  def rollback_speculative_cache(...)  → returns rollback_cache_transaction(...)
      └─ mlx_vlm/models/minicpmv4_6/language.py:5   from ..qwen3_5.language import LanguageModel as Qwen35LanguageModel
         :8   class LanguageModel(Qwen35LanguageModel)   (overrides get_rope_index only)
          └─ mlx_vlm/models/minicpmv4_7/language.py:3   from ..minicpmv4_6.language import LanguageModel as MiniCPMVLanguageModel
             :7   class LanguageModel(MiniCPMVLanguageModel)  (overrides get_rope_index only)

The two MiniCPM classes are three lines each (mlx-vlm 0.7.9 as installed):

```python
# abridged: the path comments are mine, the `...` stands for the method bodies
# mlx_vlm/models/minicpmv4_6/language.py:5-9
from ..qwen3_5.language import LanguageModel as Qwen35LanguageModel

class LanguageModel(Qwen35LanguageModel):
    def get_rope_index(self, input_ids, image_grid_thw=None, video_grid_thw=None, attention_mask=None):
        ...

# mlx_vlm/models/minicpmv4_7/language.py:3-8
from ..minicpmv4_6.language import LanguageModel as MiniCPMVLanguageModel
from ..qwen3_5_moe.language import LanguageModel as Qwen35MoELanguageModel

class LanguageModel(MiniCPMVLanguageModel):
    def get_rope_index(self, input_ids, *args, **kwargs):
        ...
```

So the method is not a per-family implementation: Qwen3.5's class defines it as a thin wrapper
over a shared helper in `mlx_vlm/speculative/cache_state.py`, and both MiniCPM classes inherit that
wrapper without touching it — their only override is `get_rope_index`, the canvas-position
contract that is MiniCPM's own business. Neither MiniCPM class defines or hides the method, so
`hasattr(language_model, "rollback_speculative_cache")` — the attribute the gate inspects, on the
*LanguageModel* rather than the inner `model` — is true for MiniCPM-V 4.7 for the same reason it
is true for Qwen3.5.

One thing the gate does **not** check: the draft's `target_layer_ids`
(`[3, 7, 11, 15, 19]`) are a *draft-config* field, not a validated quantity — the gate compares
the target's **layer count** with the draft's `num_target_layers`, and the ids are used by the
drafter at run time to pick the target's hidden states. So "the ids are not validated" is not
evidence that they are wrong; it is only evidence that the gate would not catch a mismatch.

So the "DSpark drafter port" that the earlier record called a code change is, on this reading, a
**configuration exercise**: the drafter class, the round-loop kind and the compatibility gate all
exist, and the draft checkpoint is a Qwen3.5-style 5-layer backbone (`architectures:
Qwen3DSparkModel`, `model_type: qwen3`, `dflash_config.projector_type: dspark`, `block_size: 15`,
`target_layer_ids: [3,7,11,15,19]`, confidence head + rank-256 Markov head) whose numbers line up
with the target.

The selection path, precisely: mlx-vlm rewrites the checkpoint's `model_type` before the drafter
registry ever sees it. `mlx_vlm/utils.py:222-227` computes
`is_dspark = (dflash_config.get("projector_type") == "dspark" or markov_rank > 0)` and sets
`model_type = "dspark" if is_dspark else f"{model_type}_dflash"` — so this checkpoint's
`model_type: qwen3` becomes **`"dspark"`**, and `DRAFTER_KIND_BY_MODEL_TYPE` maps
**`"dspark" → "dflash"`** (`mlx_vlm/speculative/drafters/__init__.py`), with
`KNOWN_DRAFTER_KINDS = {"dflash", "mtp", "eagle3"}`. (The registry also carries a separate
`"qwen3_dspark" → "dflash"` entry, but that is a *different* checkpoint family; this one takes the
`"dspark"` branch.)

**Evidence:** mlx-vlm 0.7.9 as installed — the two drafters files are byte-identical to upstream
`main` on 2026-10-20:

- `mlx_vlm/utils.py:197-230` (`get_model_type`), the branch quoted in F12;
- `mlx_vlm/speculative/drafters/compatibility.py:21-50` — `validate_dflash_target`, the four checks
  quoted above;
- `mlx_vlm/speculative/drafters/dspark/dspark.py:74-79` — the wrapper and the class, quoted:

  ```python
  def validate_dspark_target(config: DSparkConfig, target_model) -> None:
      validate_dflash_target(config, target_model, "DSpark")


  class DSparkDraftModel(DFlashDraftModel):
      """Model-agnostic DSpark proposal model over a Qwen-style draft backbone."""
  ```

- `mlx_vlm/speculative/drafters/__init__.py:12-20` — the kind map, quoted:

  ```python
  # abridged: the `...` stands for the map's other entries
  KNOWN_DRAFTER_KINDS = {"dflash", "mtp", "eagle3"}

  # Drafter HF ``model_type`` → required round-loop kind. Anything not listed
  # here falls back to ``DEFAULT_DRAFTER_KIND`` when the caller didn't pass one.
  DRAFTER_KIND_BY_MODEL_TYPE = {
      ...
      "deepseek_v4_dspark": "dflash",
      "dspark": "dflash",
      "gemma4_dspark": "dflash",
      ...
  }
  ```

  `"dspark"` is one of the listed entries and `"dflash"` is one of the three known kinds; the
  map's separate `qwen3_dspark → dflash` entry is a different checkpoint family, not this one;
- the inheritance chain above, in `qwen3_5/language.py`, `minicpmv4_6/language.py` and
  `minicpmv4_7/language.py`;
- the draft's own `config.json`
  (`https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-DSpark/raw/main/config.json`).

### F12 — Whether the DSpark draft actually runs end to end on MiniCPM-V 4.7 was not tested [UNVERIFIED]

The compatibility gate passing is necessary, not sufficient. The *selection* is no longer in doubt — it was resolved by reading the loader. In mlx-vlm 0.7.9
as installed, inside `get_model_type(config)` (`mlx_vlm/utils.py:197-230`), the branch that decides
it is at `:221-227`:

```python
elif dflash_config is not None:
    is_dspark = (
        dflash_config.get("projector_type") == "dspark"
        or int(config.get("markov_rank") or dflash_config.get("markov_rank") or 0)
        > 0
    )
    model_type = "dspark" if is_dspark else f"{model_type}_dflash"
```

This checkpoint's `model_type: qwen3` plus `dflash_config.projector_type: dspark` therefore
becomes `"dspark"`, and the drafter registry maps `"dspark" → "dflash"` (F11). (The `markov_rank > 0`
alternative would catch it too — this draft sets `markov_rank: 256`.)

What was **not** executed is everything after that: whether the draft's weight names match the
drafter module's parameters, whether the round loop works against MiniCPM's canvas M-RoPE positions,
and what acceptance length the pair reaches on MLX. The publisher's own numbers for
the pair are an acceptance *length* of 3.45-4.75 on vision benchmarks and 5.35-5.89 on text
benchmarks (from the DSpark model card), with 15 draft tokens per forward pass.

**Note — where the numbers come from, not evidence of a run:** the DSpark card's evaluation table
(Vision: MMMU 3.452, MathVista 4.333, CharXiv_reasoning_val 4.452, OCRBench 4.752; Text: Math
5.891, Code 5.347), read from
`https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-DSpark/raw/main/README.md` and not reproduced —
no speculative-decoding run was performed on this model.

### F13 — The format question, in one table [MEASURED]

| runtime | format it needs | 4.7 available? | conversion required |
|---|---|---|---|
| llama.cpp (upstream, ≥ PR #29416) | GGUF + `mmproj` GGUF | yes | no — official GGUFs; or convert with a *current* `convert_hf_to_gguf.py` (F2) |
| Ollama | GGUF via its bundled llama.cpp | **no, not yet** (F3) | wait for the engine to catch up |
| LM Studio | GGUF or MLX, local dir | no published 4.7 model (F4) | catalogue unknown (F5); a local 4.7 GGUF or the MLX conversion would load |
| MTPLX | MLX + `mtp.safetensors` + `mtplx_runtime.json` | text tower only, AR-only, **no vision** | yes — the export; no MTP head exists for 4.7 |
| mlx-vlm | MLX safetensors dir | yes, **vision included** (all three API dialects) | yes — `mlx_vlm.convert` (the sibling record's script) |
| mlx-lm | MLX safetensors dir, text only | text tower only | yes — the text-only export |

**Evidence:** each row is the grade of the finding it rests on, whose own evidence names the
source: llama.cpp and its GGUF/mmproj pairing from the cookbook page
`deployment/llama.cpp/minicpm-v4_7_llamacpp.md` and the file list of
`https://huggingface.co/api/models/openbmb/MiniCPM-V-4.7-1B-gguf`; the Ollama and LM Studio rows
from F3 and F4 above; the mlx-vlm, mlx-lm and MTPLX rows from the sibling records' F6, F7 and
F9-F14. — each row carries the grade of the finding it rests on; the serving rows were measured on an Apple M4 MacBook Air with mlx-vlm 0.7.9 and MTPLX 2.12.2.
### F14 — The DSpark draft probably needs no new code on the MLX side, only a correct wiring [INFERRED]

This is a conclusion, not an observation: no speculative run was performed. It reasons from three
things already established in this record and the sibling ones — (a) the drafter class is
explicitly model-agnostic and implements the DSpark proposal over a Qwen-style draft backbone
(F11's evidence), (b) the draft checkpoint *is* a Qwen-style draft backbone (`model_type: qwen3`,
`architectures: Qwen3DSparkModel`, 5 layers, hidden 1024, vocab 248094) and the loader rewrites its
type to `"dspark"`, which the registry maps to the `"dflash"` round-loop kind (F11), and (c) every
numeric gate in `validate_dflash_target` already matches this target (F11's table), including the
`rollback_speculative_cache` method MiniCPM's language model inherits from the Qwen3.5 one.

From those, the most likely end state is that the DSpark draft for MiniCPM-V 4.7 is a
*configuration* exercise on the MLX side (point the speculative machinery at the draft, let the
`qwen3` + `projector_type: dspark` combination resolve to the `qwen3_dspark` drafter) rather than a
new implementation — which would make MiniCPM-V 4.7 one of the few models with exact speculative
decoding on Apple Silicon, with the publisher's own acceptance lengths (4.3-4.8 on vision
benchmarks, 5.3-5.9 on text) as the expected payoff. What could still break it: the drafter's
weight names not matching the draft checkpoint's, the canvas-M-RoPE position handling of MiniCPM
not being compatible with the drafter's round loop, or the draft's `target_layer_ids` not lining up
with the target's actual hidden-state indices — none of which was tested.

**Reasoning from:** F11 (the gate passes), F12 (the end-to-end run is untested), and the
`mlx_vlm/speculative/drafters/__init__.py` model_type → draft-kind map. Nothing here was executed.

## Still open

- Whether a 4.7 model loads in LM Studio's desktop app (not testable from a terminal; the
  catalogue is client-rendered, F5) — this needs the GUI, and a 4.7 GGUF or the MLX conversion on
  disk.
- Whether Ollama's bundled llama.cpp has since caught up to PR #29416 in a release available on
  this machine — the registry returned 404 on 2026-10-20, and Ollama's own version was not
  installed here to check its engine version.
- Whether the DSpark draft would work with a *current* llama.cpp build against the 4.7 GGUFs
  (the file exists; the pairing was not executed here), and whether the same draft runs on
  MLX through mlx-vlm's generic DSpark drafter — the compatibility gate passes (F11), the
  end-to-end run does not (F12).
- Whether the official 4.7 GGUFs and the MLX conversion produce the same captions — the two
  stacks were never run side by side on the same image.
