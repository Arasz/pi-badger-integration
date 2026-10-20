# MiniCPM-V-4.7-1B → MLX (and → MTPLX)

Instructions and scripts for every conversion measured in this investigation. This folder holds the
runnable part; the evidence — commands, machine, conditions — is in the three research records,
one of which sits beside this README and two of which live one directory up:

- `docs/work/2026-10-20-minicpmv-4-7-1b-mlx-conversion.md` (one level up) — the MLX conversions (19 findings)
- `docs/work/2026-10-20-mtplx-format-for-minicpmv.md` — the MTPLX question (27 findings)
- `docs/work/2026-10-20-minicpmv-4-7-1b-runtime-formats.md` — which runtime takes which format (14)

Everything here was run on an **Apple M4 MacBook Air, 24 GB RAM, macOS 27.0.1**, with
**Python 3.15.0, mlx 0.32.4, mlx-vlm 0.7.9**, and MTPLX 2.12.2 for the MTPLX steps.

## TL;DR

- **To run it with vision on a Mac:** `mlx_vlm.convert` the checkpoint, then
  `python -m mlx_vlm.server --model <dir> --port 8000` — an OpenAI, Anthropic *and* Responses
  endpoint with images and multiple images per request.
- **To run it in MTPLX:** it cannot — MTPLX's loader rejects `model_type: minicpmv4_7`. Use the
  text-only export (`scripts/export_mtplx_textonly.py`), which runs AR-only, without vision.
- **Two traps before anything else:** `chmod -R u+w "$HF_HOME/hub"` (or the conversion dies with
  `Permission denied`), and the model card's `--processor-kwargs '{"downsample_mode": "4x"}'`
  is silently ignored — see Troubleshooting.
- **No "best" quant format.** A ranking measured on one photograph did not survive a four-photo
  repeat; treat the numbers in the table as indicative, not as a ranking.

## Troubleshooting

Every row is a failure this investigation actually hit, with the fix that was measured.

| symptom | cause | fix |
|---|---|---|
| `Exception: Permission denied (os error 13)` while saving `tokenizer.json` | huggingface_hub writes cache blobs read-only (444); the converter copies that mode and transformers rewrites the tokenizer in place | `chmod -R u+w "${HF_HOME:-$HOME/.cache/huggingface}/hub"` — the blobs live in `hub/blobs`, not under `models--openbmb--…` |
| `ValueError: Model type minicpmv4_7 not supported` (MTPLX) | MTPLX resolves the checkpoint's *outer* `model_type` against mlx-lm's module registry | export the text tower: `scripts/export_mtplx_textonly.py` |
| `mtplx inspect` says `can_run: true` but the run fails | recognition is a **substring match on the config's `model_type`**, so it can accept a checkpoint the loader then refuses | read the inspect verdict as "recognised", not "runnable" |
| `mtplx chat` prints the right answer and exits 4 | the exit code reports the *architecture tier*, not the run | use `mtplx run`; treat `chat`'s exit code as advisory |
| `mtplx tune` fails with `MTP injection failed` | every tune candidate loads with MTP injection on, including the AR baseline | skip the tuner on an AR-only model — there is no depth to choose |
| the API answers with an empty `content` | the MiniCPM `<think>` block is generated first and counts against `max_tokens` | raise `max_tokens`, or pass `--reasoning off` |
| `--processor-kwargs '{"downsample_mode": "4x"}'` has no effect | the kwarg never reaches the processor in mlx-vlm 0.7.9 | set `proc.image_processor.downsample_mode = "4x"` at runtime, or `"downsample_mode": "4x"` in the model dir's `processor_config.json` |
| 4-bit barely shrinks the model | the vision tower, mergers, embeddings and output head stay BF16 in every format | accept ~14% saving; 4-bit is a speed/memory choice, not a size one |

## Requirements

- **Apple Silicon macOS** — `mlx` is Apple-only. macOS 26.0+ is what MTPLX 2.12 needs; the
  conversions themselves need nothing newer than macOS 14.
- **Python 3.10+** (3.15.0 measured) and roughly **1 GB of disk for the venv**.
- **~16 GB of free disk** for all five formats plus the two exports (measured: 15 GB for five
  checkpoints and two exports). One format plus its export is ~5.5 GB.
- **Network access** on the first run, for the ~3.1 GB source checkpoint and the `mlx-vlm` wheel.
- For the MTPLX steps: the MTPLX app or CLI (2.12.2 measured). The MTPLX steps are optional —
  the MLX conversions and `mlx_vlm.server` need nothing from MTPLX.

## One command for everything

```bash
docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/convert_minicpmv47.sh
```

It creates the venv, installs `mlx-vlm==0.7.9`, makes the HF cache writable, converts the model
in every format, produces the MTPLX text-only export, and prints one caption per checkpoint to
prove each one loads and sees the image. It stops at the first failure (exit 3) rather than
reporting success over a checkpoint that was not built. Overrides:

```bash
KIT=docs/work/2026-10-20-minicpmv-4-7-1b-kit
FORMATS="bf16 affine4" OUT_ROOT=~/models/mc47 VENV=~/venvs/mc47 $KIT/scripts/convert_minicpmv47.sh
DO_EXPORT=0 DO_VERIFY=0 $KIT/scripts/convert_minicpmv47.sh      # conversions only
$KIT/scripts/convert_minicpmv47.sh --help
```

## The conversions, one by one

All of them take the same shape — `mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path
<out> --dtype bfloat16` plus the quantisation flags for that format:

| name | extra flags | size | converter says | mean similarity to the bf16 reference (4 photos) |
|---|---|---|---|---|
| `bf16` | — | 3109 MB | — | **0.341** (the reference's own format) |
| `affine4` | `-q --q-bits 4 --q-group-size 64 --q-mode affine` | 2666 MB | 13.719 bits/weight | 0.169 |
| `mxfp4` | `-q --q-bits 4 --q-mode mxfp4` | 2656 MB | 13.670 bits/weight | 0.119 |
| `nvfp4` | `-q --q-bits 4 --q-mode nvfp4` | 2666 MB | 13.719 bits/weight | not measured on the photo set (0.150 on one photo) |
| `mxfp8` | `-q --q-bits 8 --q-group-size 32 --q-mode mxfp8` | 2810 MB | 14.463 bits/weight | not measured on the photo set (0.107 on one photo) |

Sizes are re-measured 2026-10-20 from the pinned source revision; an earlier run produced figures
~5% smaller for bf16 — see F20 in the record for what did and did not reproduce.

AWQ is also available: add `--quant-method awq --calibration multimodal --calibration-data <dir of
images>`. It scaled only 6 layers / 18 groups on a four-image calibration set and scored 0.129 —
inside the noise of the plain RTN run (0.169), i.e. no measurable gain here.

**Read the numbers honestly.** A single photo put mxfp4 far ahead of affine 4-bit (0.192 vs 0.052);
over four photos that ordering *flipped* (0.119 vs 0.169), and the per-photo spread within one
format (0.082-0.348) is larger than the gap between formats. The stable statements are: the
unquantised bf16 checkpoint matches the transformers reference best, and no quant format
dominates another. A ranking of these formats from a caption on one image is unfounded — see
F18 in the record.

The effective bit rate is high in every row because the vision tower, the mergers, the
embeddings, the output head and the recurrent `A_log` tensors stay BF16 in all of them — 4-bit
quantisation of this model saves ~14% of the size, not 75%.

Measured wall time for one conversion, warm cache, on the M4: **4.6 s** (bf16) and **9.7 s**
(4-bit). A cold run adds the ~3 GB download.

### The gotcha that hits every first-time user

`mlx_vlm.convert` fails with

```
Exception: Permission denied (os error 13)
```

while saving the tokenizer. `huggingface_hub` writes cache blobs read-only (444); the converter
copies that mode into the output directory and `transformers` then rewrites `tokenizer.json` in
place. The weights are already written at that point, so the output directory *looks* complete and
is not. Reproduced on a pristine cache, so it is not a stale-cache artefact.

Fix (one command, before converting):

```bash
chmod -R u+w "${HF_HOME:-$HOME/.cache/huggingface}/hub"
```

Note the blobs live in `hub/blobs`, **not** under `models--openbmb--MiniCPM-V-4.7-1B`, so
`chmod`ing only the model directory does not help. The alternative is to download a snapshot to a
writable directory, `chmod -R u+w` it, and convert from that local path.

## Using the checkpoints

```bash
# one caption
mlx_vlm.generate --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-affine4 \
  --image photo.jpg --prompt "Describe this image." --max-tokens 200 --temperature 0

# an OpenAI / Anthropic / Responses server, with images
python -m mlx_vlm.server --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-mxfp4 --port 8000
```

The server takes images on all three dialects — an OpenAI `image_url` data URL, an Anthropic
`{"type":"image","source":{"type":"base64",…}}`, or a Responses `{"type":"input_image"}` — and
handles **several images in one message**, describing them in order. Measured request:

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<the served model path>","messages":[{"role":"user","content":[
        {"type":"text","text":"Describe each image in one short sentence, in order."},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,…"}},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}]}],"max_tokens":120}'
```

The `model` field must be the **served model id** (the path you passed to `--model`), not a
friendly name — anything else is looked up on the Hub and fails with `404 Repository Not Found`.

### `downsample_mode` (16x / 4x)

The model card says to pass `--processor-kwargs '{"downsample_mode": "4x"}'`. In mlx-vlm 0.7.9 that
flag is **silently dropped** — the kwarg never reaches the processor, the mode stays `16x`, and the
run produces exactly the 16x output. Two routes that do work:

```python
# at runtime, no file edits
proc.image_processor.downsample_mode = "4x"      # and proc.video_processor
```

```bash
# persistently: edit the model directory's processor_config.json
#   "image_processor": { ..., "downsample_mode": "4x" }
#   "video_processor": { ..., "downsample_mode": "4x" }
```

What the option actually does: **not** a resolution change. The pixels are identical in both modes
(`pixel_values` shape (3, 14, 14112) either way). It is a *token packing* factor: one token covers
a 4×4 block of visual patches at 16x (315 image tokens for the test photo) and a 2×2 block at 4x
(1260 tokens) — and the visual RoPE layout follows. In code, the two sides express it differently
but agree: the model uses `factor = 2 if mode == "4x" else 4` and checks
`prod(grid // factor) == visual token count`, while the processor divides the target size by
`4 if "4x" else 16` — the *square* of that factor.

## MTPLX

MTPLX's own model format is an MLX build plus the model's own MTP head as a standalone
`mtp.safetensors` sidecar plus an `mtplx_runtime.json` contract, produced by `mtplx forge` from a
source checkpoint that already contains MTP weights. Forge does not do plain conversions, and it
refuses to attach a third-party sidecar to an arbitrary trunk.

MiniCPM-V 4.7 has no native MTP head (its `DSpark` draft is a separate 213 M-parameter checkpoint
meant for llama.cpp), so the full multimodal checkpoint **cannot** be converted for MTPLX:

```
$ mtplx run --model <the converted MLX dir> --prompt hi
ValueError: Model type minicpmv4_7 not supported.
```

(`mtplx inspect` is optimistic about the same directory: `can_run: true`, tier
`architecture-compatible-but-unverified`.)

What does work is exporting the **text tower**, which is a Qwen3.5 text model
(`text_config.model_type == "qwen3_5_text"`) that mlx-lm's `qwen3_5` module matches
tensor-for-tensor while skipping the vision tower:

```bash
docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/export_mtplx_textonly.py <src-mlx-dir> <dst-dir>
```

That keeps only the `language_model.*` tensors — **513 of 972** from an affine-4bit source
(2666 MB → 1569 MB) or **321 of 780** from a bf16 source (3109 MB → 2012 MB) — drops the 459
vision/merger tensors, and rewrites `config.json` to `model_type: qwen3_5` with the original
`text_config` and the affine-4-bit quantization block. Sharded checkpoints (the 35B-A3B's five
shards, with a `model.safetensors.index.json`) are read through the index and merged, so the same
command works for them. The result:

```bash
mtplx run --model <dst-dir> --prompt "Say hello in exactly three words." --reasoning off
# [mtplx] profile=sustained mode=AR mtp_depth=0 tokens=9 tok_s=64.36

mtplx serve --model <dst-dir> --port 8123 --no-auth
# /v1/models      → {"id":"…","supports_vision":false,"context_length":262144}
# /v1/chat/completions → the answer, with the MiniCPM thinking in "reasoning_content"
# /v1/messages    → an Anthropic-style thinking block + content
```

Costs of the export: no image input, no speculative decoding (`mtp_depth=0`, AR only), and
`--reasoning off` if you do not want the MiniCPM thinking block printed as the answer. Every load
also prints a transformers warning about the tokenizer's regex pattern; it is noise, not a fault.

## Reproduce and check

All commands are written **from the repository root** and are copy-pasteable as they stand:

```bash
KIT=docs/work/2026-10-20-minicpmv-4-7-1b-kit

# the whole chain: environment, five conversions, the export, one caption per checkpoint
$KIT/scripts/convert_minicpmv47.sh

# the MTPLX text-only export on its own
$KIT/scripts/export_mtplx_textonly.py <src-mlx-dir> <dst-dir>

# every finding pointer in the three records resolves, and every grade marker is in the closed set
python3 $KIT/scripts/check_record_refs.py "docs/work/2026-10-20-*.md"

# every cited line still says what the record claims (needs the pinned sources — see the script)
python3 $KIT/scripts/check_citations.py "docs/work/2026-10-20-*.md"
```

(The two checkers also locate the repository root themselves, so running them from inside the kit
folder works too.)

## Files

- `docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/convert_minicpmv47.sh` — every conversion, the export, and the verification pass
- `docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/export_mtplx_textonly.py` — the MTPLX text-only export (verbatim in the MTPLX record's F13)
- `docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/check_citations.py` — re-reads the pinned sources (mlx-lm 0.31.3 from MTPLX's runtime
  venv, mlx-vlm 0.7.9 from a venv, MTPLX `main` unpacked) and verifies that every `file.py:NN`
  citation in the records still points at a real line, with the quoted fragment present there. Set
  the `SRC` map at the top of the script to wherever those live on your machine, then run:

  ```bash
  python3 docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/check_citations.py "docs/work/2026-10-20-*.md"
  ```

- `docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/check_record_refs.py` — prints every `F<n>` pointer in these records next to the finding it
  resolves to **and the record that finding lives in** (so a stale pointer from a renumber is
  visible, and a cross-record pointer is checked against the right file); lints the grade markers
  against the closed set {MEASURED, READ, INFERRED, UNVERIFIED}; prints the per-record and total
  grade mix; flags an empty or missing `## Still open` section (the skill's checklist says an empty
  one must be defended); and rejects three phrasings that were wrong in earlier drafts and were
  corrected by re-reading the cited source — so those corrections cannot silently come back. It
  exits non-zero on any of those; run it after adding or moving a finding:

  ```bash
  python3 docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/check_record_refs.py "docs/work/2026-10-20-*.md"
  ```

## Related records

- `docs/work/2026-10-20-mtplx-format-for-minicpmv.md` — what MTPLX's format is, and why the full
  multimodal checkpoint cannot be converted for it
- `docs/work/2026-10-20-minicpmv-4-7-1b-runtime-formats.md` — which local runtime accepts which
  format for this model (llama.cpp GGUF + mmproj, Ollama not yet, LM Studio none published,
  mlx-vlm full multimodal, mlx-lm and MTPLX text-only)
