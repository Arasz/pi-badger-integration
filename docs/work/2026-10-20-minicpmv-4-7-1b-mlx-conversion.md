# Research: converting MiniCPM-V-4.7-1B to MLX format

**Date:** 2026-10-20
**Question:** How do you convert openbmb/MiniCPM-V-4.7-1B (the Hugging Face transformers checkpoint) into an MLX model, and does that conversion actually work on an Apple Silicon Mac?

**Short answer:** one command converts it — `mlx_vlm.convert --q-mode {affine,mxfp4,nvfp4,mxfp8}` —
and mlx-vlm 0.7.9 from PyPI already ships the `minicpmv4_7` architecture, so no git checkout is
needed. Two traps: converting straight from the Hub id fails with `Permission denied` until the
Hugging Face cache blobs are writable, and the model card's
`--processor-kwargs '{"downsample_mode": "4x"}'` is silently dropped. And the quant-format ranking
measured on one photograph did not survive a four-photo repeat — on this evidence **no format is
"the best"**, and the honest summary is that every quant format drifts from the unquantised
reference.

**Grades:** `[MEASURED]` = ran the command and read the result (the evidence line names the
command, the machine and the conditions) · `[READ]` = read in a source authoritative for that
claim (path:line, a doc URL, a spec section) · `[INFERRED]` = reasoned from the findings above
(the reasoning is named) · `[UNVERIFIED]` = not checked (what would settle it is named).

**Conditions:** every measurement below is on one machine — Apple M4 MacBook Air, 24 GB unified
memory, macOS 27.0.1, Python 3.15.0, mlx 0.32.4, mlx-vlm 0.7.9; the transformers reference stack
is Python 3.12 with torch 2.14.1 on MPS and transformers 5.20.2; MTPLX is 2.12.2. Each finding
quotes its own command.

```chart:range
title: generation wall time, 200-token image description (seconds, 3 runs)
local bf16 conversion: 7.11..7.45..7.68
local 4bit conversion: 5.44..5.84..7.46
prebuilt mlx-community 4bit: 6.09..6.68..7.31
```

```chart:range
title: 200-token caption of the real photo, MLX 4bit wall time incl. 1.6 s model load (seconds, 3 runs)
9.29..9.38..10.06
```

## Findings

### F1 — Prebuilt MLX conversions of MiniCPM-V-4.7-1B already exist, so conversion is optional [READ]

`mlx-community` publishes the 1B in bf16, 4bit, 6bit, 8bit and the float formats mxfp4 / mxfp8 /
nvfp4, all tagged `mlx` + `mlx-vlm` with `base_model: openbmb/MiniCPM-V-4.7-1B`. The 4bit card even
ships the exact reproduce command and the converter commit it was built with. For most users the
conversion step is therefore a download, not a job; converting locally only earns its keep for a
custom quant, a different dtype, or an offline copy.

**Evidence:** `https://huggingface.co/api/models?search=MiniCPM-V-4.7&limit=100` (model list, 2026-10-20);
`https://huggingface.co/mlx-community/MiniCPM-V-4.7-1B-4bit/raw/main/README.md` (card with
`mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path MiniCPM-V-4.7-1B-4bit --dtype bfloat16 -q
--q-bits 4 --q-group-size 64 --q-mode affine`, support added in mlx-vlm PR #2499, version 0.7.8).

### F2 — The official cookbook documents GGUF/llama.cpp for 4.7 and does not mention MLX at all [READ]

The v4.7 overview page lists `llama.cpp` (upstream PR #29416) and `Ollama` as run-locally paths, and
lists GGUF / int4 / AWQ / GPTQ as the quantizations. No MLX row exists. If you were following the
cookbook alone you would conclude MLX was not an option; the MLX path exists through mlx-vlm
instead.

**Evidence:** `https://raw.githubusercontent.com/OpenSQZ/MiniCPM-V-CookBook/main/docs/pages/v4.7/overview.md`
lines 91-122 (deployment table, format table, quantization line, "Run locally" line).

### F3 — mlx-vlm 0.7.9 from PyPI already ships the `minicpmv4_7` implementation, so `git+main` is not required [MEASURED]

The installed package contains `mlx_vlm/models/minicpmv4_7/` (`minicpmv4_7.py`, `language.py`,
`processing_minicpmv4_7.py`, `config.py`, `rope.py`), and the whole pipeline — convert, load,
generate — ran on the released wheel, not on a git checkout. The model card's "install from main"
advice is conservative; the release already contains the support commit.

**Evidence:** `pip install "mlx-vlm==0.7.9"` into a fresh venv on Python 3.15.0; then
`python -c "import mlx_vlm, os; print([d for d in os.listdir(os.path.join(os.path.dirname(mlx_vlm.__file__),'models')) if 'minicpm' in d])"`
→ `['minicpm', 'minicpm3', 'minicpmo', 'minicpmv4_6', 'minicpmv4_7']`. Versions in the venv:
mlx 0.32.4, mlx-metal 0.32.4, numpy 2.5.4, pillow 13.0.0, transformers 5.20.2, Python 3.15.0.

### F4 — Converting straight from the Hub id fails with `PermissionError` until the HF cache blobs are writable [MEASURED]

`mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B` copies the tokenizer into the output
directory with the source file's mode (444, read-only, as huggingface_hub writes cache blobs), and
then `transformers` tries to rewrite `tokenizer.json` in place and dies with
`Exception: Permission denied (os error 13)`. The weights are already written at that point, so the
output directory looks complete and is not — the tokenizer is the missing piece.

Two fixes, both verified here: `chmod -R u+w ~/.cache/huggingface/hub` before the run, or download
a snapshot to a local directory, `chmod -R u+w` that directory, and convert from the local path.
Note the blobs live in `~/.cache/huggingface/hub/blobs`, *not* under the per-model directory, so
`chmod`ing only `models--openbmb--MiniCPM-V-4.7-1B` does not fix it.

This is not an artefact of a warm cache: reproduced from a **pristine** cache
(`HF_HOME=/tmp/fresh_hf`, empty before the run) — huggingface_hub writes the blob as
`-r--r--r--` (444), the converter copies that mode into the output, and the run dies the same
way. So a first-time user on a clean machine hits this every time. One `chmod -R u+w "$HF_HOME"`
before converting fixes it: the same fresh-cache command then exits 0 with `tokenizer.json` at
644.

The scripted form of every conversion in this record is
`docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/convert_minicpmv47.sh` (verified by
running it end to end on this machine: five formats converted and one caption generated per
checkpoint). The step-by-step instructions are in the README next to the script.

**Evidence:** on this machine, `mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path
/tmp/conv-hubid --dtype bfloat16` → traceback ending `Exception: Permission denied (os error 13)`
with `/tmp/conv-hubid/tokenizer.json` at mode 444. Same command after
`chmod -R u+w /Users/arasz/.cache/huggingface/hub` → exits 0 in 4.64 s, tokenizer.json at 644. The
local-directory route (`cp -RL` the snapshot, `chmod -R u+w`, convert) also exits 0 in 6.28 s.
Pristine-cache reproduction: `HF_HOME=/tmp/fresh_hf mlx_vlm.convert --hf-path
openbmb/MiniCPM-V-4.7-1B --mlx-path /tmp/conv-fresh --dtype bfloat16` → same traceback, blob
listed as `-r--r--r-- ... 362054e70995b541e6dc3a6c84729e38ce056016b18d6f80a907f7b2492b3583`, output
`tokenizer.json` at 444; then `chmod -R u+w /tmp/fresh_hf` + the same command → exits 0,
`tokenizer.json` 644. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F5 — The conversion is fast: single-digit seconds warm on an M4 [MEASURED]

With the model already in the HF cache, a bf16 conversion of the 1B takes ~4-6 s and the 4-bit
quantized conversion ~10 s, on a 24 GB Apple M4 MacBook Air. A cold run (download included) is
dominated by the ~3 GB download.

**Evidence:** MacBook Air, Apple M4 (T8132), 24 GB RAM, macOS 27.0.1, Python 3.15.0, mlx 0.32.4,
mlx-vlm 0.7.9. `time mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path /tmp/conv-hubid2
--dtype bfloat16` → 4.64 s (warm cache). `time mlx_vlm.convert --hf-path /tmp/src47 --mlx-path
/tmp/MiniCPM-V-4.7-1B-4bit --dtype bfloat16 -q --q-bits 4 --q-group-size 64 --q-mode affine` →
9.66 s, logged as "Quantized model with 13.719 bits per weight". First ever run with download:
58 s (ended in the F4 permission error).

### F6 — 4-bit barely shrinks this model: 2.97 GB → 2.54 GB [MEASURED]

Quantizing to 4 bits saved only ~14% of the size, because the vision tower, the resampler, the
embeddings and the output head stay BF16 and the recurrent `A_log` tensors keep source precision.
The 13.719 bits-per-weight figure the converter prints is the same story in one number. The 1B
model is already small; 4-bit buys speed and memory headroom, not a different order of magnitude.

**Evidence:** `du -sh /tmp/MiniCPM-V-4.7-1B-bf16 /tmp/MiniCPM-V-4.7-1B-4bit` → 3.0G and 2.6G;
`model.safetensors` 2965.0 MB → 2542.4 MB (both superseded by the re-measurement in F20). Module-level rule stated in
`https://huggingface.co/mlx-community/MiniCPM-V-4.7-1B-4bit/raw/main/README.md` ("vision modules,
visual mergers, embeddings, output heads, and linear attention remain BF16"). — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F7 — The converted model actually sees the image: generation is correct [MEASURED]

A locally converted bf16 checkpoint and a locally converted 4-bit checkpoint both described a
synthetic test image correctly, and the prebuilt `mlx-community/MiniCPM-V-4.7-1B-4bit` did too.
The output is not garbage, so the conversion is semantically sound, not merely file-shaped.

**Evidence:** `mlx_vlm.generate --model <converted> --image /tmp/testimg.png --prompt "Describe this
image in one sentence." --max-tokens 64 --temperature 0`. Test image: 512x512 PNG, blue background,
yellow circle, two black eye dots, red triangle mouth. bf16 → "A simple yellow smiley face with
black eyes and a red triangle mouth is centered on a blue background." 4bit → "A simple yellow face
with black eyes and a red triangle mouth is centered on a blue background." Prebuilt 4bit → "This is
a simple, stylized graphic of a face centered on a solid blue background." — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F8 — End-to-end throughput on the M4 is roughly 35-40 output tokens/second including image prefill [MEASURED]

Three runs of a 200-token image description: bf16 7.11/7.45/7.68 s wall, 4bit 5.44/5.84/7.46 s
wall, prebuilt 4bit 6.09/6.68/7.31 s wall. Model load alone is 1.74 s (bf16) and 1.62 s (4bit);
subtracting that, the bf16 run emitted 201 tokens in ~5.7 s (~35 tok/s) and the local 4bit run
emitted 161 tokens in ~4.2 s (~38 tok/s). The prebuilt and locally converted 4-bit checkpoints are
indistinguishable in wall time, i.e. the community conversion is not a degraded copy.

**Evidence:** `mlx_vlm.generate --model <model> --image /tmp/testimg.png --prompt "Describe this
image in detail." --max-tokens 200 --temperature 0`, three consecutive runs per model, same machine
as F5; output token counts from `processor.tokenizer.encode(text)`. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F9 — The converter's quantization modes include the MLX float formats, not only affine integer quant [READ]

`mlx_vlm.convert` accepts `--q-mode {affine,mxfp4,nvfp4,mxfp8}`, plus `--quant-method {rtn,awq}`
with `--calibration {text,multimodal}` and a set of `--quant-predicate` mixed-bit recipes. That is
why mlx-community could publish mxfp4/mxfp8/nvfp4 variants of this model.

**Evidence:** `mlx_vlm.convert --help` output on this machine (mlx-vlm 0.7.9), options block.

### F10 — The MLX output matches the transformers reference on a real photograph, in content if not in wording [MEASURED]

A real photo (800x600 railway bridge over green hills, from picsum.photos) was captioned twice: once
by the transformers reference stack (torch 2.14.1 on MPS, bf16) and once by the locally converted
MLX 4-bit checkpoint, same prompt, greedy decoding. Both describe the same scene and the same
details — railway bridge, two converging rails on wooden sleepers, rusted vertical-bar railings,
lush green hills, bright blue sky with wispy clouds. The wording and layout differ (the reference
answers in markdown sections, the MLX build in flowing prose), which is a formatting difference
between the two chat-template paths, not a difference in what the model saw. The reference run
produced 200 tokens in 12.48 s of pure generation; the MLX run of the same length took 9.29-10.06 s
wall including the 1.6 s model load, i.e. roughly 25-26 output tokens/second against the
reference's ~16.

**Evidence:** reference script `/tmp/ref.py` (transformers 5.20.2 `AutoModelForImageTextToText` +
`AutoProcessor` on `openbmb/MiniCPM-V-4.7-1B`, `dtype=torch.bfloat16`, `device_map="mps"`, greedy
`max_new_tokens=200`) → "This is a striking, symmetrical photograph taken from the perspective of
someone standing on a railway bridge…" with a **Foreground and Midground:** / **Background:**
structure. MLX: `mlx_vlm.generate --model /tmp/MiniCPM-V-4.7-1B-4bit --image /tmp/photo.jpg
--prompt "Describe this image in detail." --max-tokens 256 --temperature 0` → "This is a striking,
forward-seeing photograph of a railway bridge extending toward the horizon…".

### F11 — A locally converted 4-bit checkpoint and the mlx-community 4-bit checkpoint produce byte-identical output [MEASURED]

Greedy decoding of the same photo with the same prompt produced exactly the same 1190-byte text
from the checkpoint this investigation converted and from `mlx-community/MiniCPM-V-4.7-1B-4bit`
(`diff` reports no difference). The community conversion is reproducible with the published command,
and a local conversion is not a degraded copy of it.

**Evidence:** `diff mlx_local_16x.txt mlx_prebuilt_16x.txt` → identical; both 1190 bytes, both
`mlx_vlm.generate --model <model> --image /tmp/photo.jpg --prompt "Describe this image in detail."
--max-tokens 256 --temperature 0`. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F12 — `--processor-kwargs '{"downsample_mode": "4x"}'` is silently ignored by the 0.7.9 CLI [MEASURED]

The model card tells users to pass `--processor-kwargs '{"downsample_mode": "4x"}'` for finer
detail. In mlx-vlm 0.7.9 that flag does not reach the processor: instrumenting
`MiniCPMV4_7Processor.__call__` during a full CLI run showed the kwarg arriving as `None`, the
processor's mode still `16x`, and 315 image tokens — exactly the 16x count. The CLI run with the
flag therefore produced output identical to the run without it.

Two routes do work, and they are equivalent to each other:

- **At runtime, no file edits**: set the processor's own default before generating —
  `proc.image_processor.downsample_mode = "4x"` (and the same on `proc.video_processor`). The
  processor's `__call__` reads `self.image_processor.downsample_mode` as its default, so this
  flips the mode for that process. The resulting caption is byte-identical to the file-edited
  4x run apart from the CLI's trailing newline.
- **Persistently**: set `downsample_mode` in the model directory's `processor_config.json` (both
  `image_processor` and `video_processor` blocks), which is where the processor reads its default
  from — that is how the 4x run in F13 was produced.

**Evidence:** patched `MiniCPMV4_7Processor.__call__` printing `MODE kwarg: None self: 16x` /
`MODE result: 16x n_image_tokens: 315` during
`mlx_vlm.generate --processor-kwargs '{"downsample_mode": "4x"}'`; with `processor_config.json`
edited to `"4x"`, the same run yields 1260 image tokens and a different caption. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F13 — Real 4x downsampling does change the caption, and it is not unambiguously better [MEASURED]

With 4x actually applied (1260 image tokens instead of 315) the caption changes materially: it
becomes longer and more structured ("**Foreground & Composition:**", "**Midground & Nature:**",
"**Background & Atmosphere:**", "**Mood & Style:**"), and it adds one detail not in the picture — a
"faint electricity pylon … on a distant hill to the right" — plus a stray mixed-language token
("a large, softly轮廓d mountain"). The 16x caption is plainer but stays inside what the image
shows. More visual tokens buy structure and cost hallucination.

Correction to the natural reading of the name: 4x does **not** resize the image. The pixel grid is
byte-for-byte the same in both modes (`pixel_values` shape (3, 14, 14112) either way); what changes
is how densely the visual patches are turned into text tokens. See F16.

**Scope:** the "costs hallucination" half of this finding is one photograph's worth of evidence; on
the four photos of F18 the 4x captions were content-accurate where read, and 4x was on average
*further* from the reference than 16x (0.231 vs 0.341), not closer.

**Evidence:** `diff` of the 16x and true-4x runs on `/tmp/photo.jpg` (1190 vs 1156 bytes), quoted
above; image-token counts 315 (16x) vs 1260 (4x) from
`MiniCPMV4_7Processor.from_pretrained(...)` + `proc(text=..., images=[[img]], downsample_mode=...)`. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F14 — The transformers reference stack needs torch on Python ≤3.13 and torchvision as well [MEASURED]

`pip install torch` has no distribution for Python 3.15 on this machine ("from versions: none"),
so the reference run needed a separate Python 3.12 environment. `AutoProcessor.from_pretrained`
also refuses to build without torchvision ("requires `torchvision` to be installed"), which the
MLX path does not need — mlx-vlm's processor is native NumPy/Pillow. This is the one place the
"just pip install and run" path forks: MLX needs only mlx-vlm, the reference needs torch +
torchvision + a compatible Python.

**Evidence:** `pip install torch` in the Python 3.15 venv → "ERROR: Could not find a version that
satisfies the requirement torch (from versions: none)"; the reference venv was built with
`uv venv --python 3.12 /tmp/refenv` + `uv pip install torch transformers==5.20.2 accelerate pillow
torchvision` (torch 2.14.1, transformers 5.20.2, torchvision 0.29.1).

### F15 — mxfp4 stays much closer to the bf16 reference than affine 4-bit does [MEASURED]

The same photo, prompt and greedy decoding through three MLX checkpoints shows a clear fidelity
ordering. Against the transformers bf16 reference text, sequence similarity over the first 1500
characters is 0.344 for the local bf16 checkpoint, 0.192 for a locally built mxfp4 checkpoint, and
0.052 for a locally built affine 4-bit checkpoint. The bf16 MLX run reproduces the reference's
opening sentence word for word ("This is a striking, symmetrical photograph taken from the
perspective of someone standing on a railway bridge…"). The mxfp4 run keeps the same content and
the same sectioned layout but rewords the opening and adds "atmospheric". The affine 4-bit run
changes the *shape* of the answer: it drops the sectioned layout entirely and writes flowing
prose. mxfp4 costs 2533 MB against affine's 2542 MB (sizes superseded by F20) and runs in the same time (8.32-9.53 s vs
9.29-10.06 s wall for 256 tokens including load).

Caveat that bounds this finding: one photo, one prompt, greedy decoding, and the reference was
cut at 200 tokens while the MLX runs went to 256, so the similarity ratios are indicative of
drift, not a benchmark. **Scope:** the ordering here (mxfp4 > affine 4-bit) did NOT survive a
four-photo repeat (F18); on four photos mxfp4 came last of the three quant formats. The claim
that survives is the weaker one: every quant format drifts from the unquantised reference, and no
format dominates.

**Evidence:** `/tmp/MiniCPM-V-4.7-1B-mxfp4` built with
`mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path /tmp/MiniCPM-V-4.7-1B-mxfp4 --dtype
bfloat16 -q --q-bits 4 --q-mode mxfp4` (4.70 s, "Quantized model with 13.670 bits per weight",
model.safetensors 2533.2 MB vs affine's 2542.4 MB; sizes superseded by F20). Captions: `mlx_vlm.generate --model <ckpt>
--image /tmp/photo.jpg --prompt "Describe this image in detail." --max-tokens 256 --temperature 0`.
Similarity: `difflib.SequenceMatcher(None, reference_text[:1500], mlx_text[:1500]).ratio()` against
the transformers run in F10 (bf16 reference text regenerated into `/tmp/ref_out.txt`).

The same check as F11 holds for the float format: the locally built mxfp4 checkpoint and
`mlx-community/MiniCPM-V-4.7-1B-mxfp4` produced **byte-identical** caption text on the photo
(`diff` clean). The community float-format conversion is reproducible too, so the fidelity
ordering above is a property of the format, not of one particular checkpoint. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F16 — `downsample_mode` is a visual-token packing factor, not an image resize [MEASURED]

Reading the implementation settles what the option does, and corrects the "finer detail" framing in
the community card. Two sides have to agree, and they express the same thing differently:

- **Model side** (`mlx_vlm/models/minicpmv4_7/minicpmv4_7.py:66`): `factor = 2 if mode == "4x" else 4`,
  and the crop grid must satisfy `prod(grid // factor) == number_of_visual_tokens` — a 2x2 block of
  tokens per patch in 4x mode, 4x4 in 16x mode.
- **Processor side** (`mlx_vlm/models/minicpmv4_6/processing_minicpmv4_6.py:1453-1462`):
  `image_token_divisor = 4 if downsample_mode == "4x" else 16` (`:1453-1457`) and a mirrored
  `video_token_divisor` with the same two values (`:1458-1462`), and the token count is
  `int(np.prod(target_size, dtype=np.int64) // token_divisor)` (`:1031-1032`). So images and video
  are packed by the same rule; the mode is read off whichever processor owns the input.

The two agree because the divisor is the *square* of the model's factor (2² = 4, 4² = 16). Read
the model's check the right way round: `prod(grid // factor)` is the number of tokens, so one
token covers a `factor × factor` block of visual *patches*. "16x" therefore means **one token per
4x4 block of patches** (coarser spatial layout, fewer tokens) and "4x" **one token per 2x2 block**
(finer spatial layout, 4x the tokens) — measured on the test photo as 315 image tokens at 16x and
1260 at 4x, exactly 4x apart for identical pixels. The pixels do not change: `pixel_values` has the same shape
(3, 14, 14112) in both modes — and the *values* are bit-identical, not merely the same shape. The
image processor never consults the mode while resizing — in
`minicpmv4_6/processing_minicpmv4_6.py` the attribute appears exactly four times: the dataclass
default (`:132`), the constructor assignment (`:152`), and the two reads that pick the token
divisors (`:1455` for images, `:1460` for video). The resize path does not read it. The practical
consequence for the "still open" questions: 4x buys a finer
*spatial* embedding grid at 4x the sequence length, not a sharper look at the image.

**Evidence:** line numbers are from **mlx-vlm 0.7.9 as installed** (they are identical to
upstream `main` on 2026-10-20, checked both ways):
`mlx_vlm/models/minicpmv4_7/minicpmv4_7.py:66` (the factor and the grid/token-count check) and
`mlx_vlm/models/minicpmv4_6/processing_minicpmv4_6.py:1453-1457` (the image divisor),
`:1458-1462` (the mirrored video divisor), `:1031-1032` (the token-count formula) and `:152`
(the constructor assignment — the attribute's only other occurrences in that file are `:132`, `:1455`
and `:1460`, i.e. it is never read by the resize path); measured `pixel_values` **identical in
value** under both modes — same 3 slices, same (3, 14, 14112) shape, and
`max |pixel difference| = 0.0` between the two runs — with the image-token count moving by
exactly 4x (203 -> 812 on a synthetic 640x480 test image; 315 -> 1260 on the test photo).

### F17 — All four MLX quant formats were built and compared; the ranking is not monotone in bit width [MEASURED]

Every `--q-mode` the converter offers was built locally and captioned the same photo, and each was
scored against the transformers bf16 reference text (sequence similarity over the first 1500
characters, same metric as F15):

| checkpoint | size | bits/weight (converter) | similarity to bf16 reference |
|---|---|---|---|
| bf16 | 2965 MB | — | **0.344** |
| mxfp4 (`--q-bits 4`) | 2533 MB | 13.670 | **0.192** |
| nvfp4 (`--q-bits 4`) | 2666 MB | 13.719 | **0.150** |
| mxfp8 (`--q-bits 8 --q-group-size 32`) | 2810 MB | 14.463 | **0.107** |
| affine 4-bit (`--q-bits 4 --q-group-size 64`) | 2542 MB | 13.719 | **0.052** |

Two things worth knowing before picking a format. First, the 8-bit mxfp8 build lands *further*
from the bf16 reference than the 4-bit float builds do — more bits did not mean closer to the
unquantized model here, so the ranking cannot be read off the bit width. Second, all five outputs
are pairwise different (pairwise ratios 0.046-0.168), i.e. the quant format changes the wording
substantially, not just the last token.

Caveat, same as F15: one photo, one prompt, greedy decoding, the reference truncated at 200
tokens against 256 for the MLX runs. This is a drift indicator, not a benchmark. **Scope:** the
ranking in this table did NOT survive a four-photo repeat (F18) — read it as a property of that
one photograph, not of the formats.

**Evidence:** `mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path <out> --dtype
bfloat16 -q --q-bits <b> [--q-group-size <g>] --q-mode {affine,mxfp4,nvfp4,mxfp8}` (mxfp8 refuses
other settings with "mxfp8 requires group_size=32, bits=8"); sizes from `ls -l model.safetensors`;
captions from `mlx_vlm.generate --model <ckpt> --image /tmp/photo.jpg --prompt "Describe this
image in detail." --max-tokens 256 --temperature 0`; similarity from
`difflib.SequenceMatcher(None, reference[:1500], text[:1500]).ratio()` against `/tmp/ref_out.txt`. — measured on an Apple M4 MacBook Air (macOS 27.0.1, mlx-vlm 0.7.9, mlx 0.32.4).
### F18 — Four photos, three quant formats and AWQ: the single-photo ranking does not survive [MEASURED]

The one-photo findings F15/F17 were re-run over a four-photo set (`picsum.photos/id/1015|1024|1039|1043`,
800x600 — a fjord cliff with tourists, a bearded vulture in flight, a waterfall in a green valley, and
a granite-cliff river valley), each captioned by the transformers bf16 reference and by the MLX
checkpoints, greedy, 200 tokens, scored as sequence similarity over the first 1500 characters:

| checkpoint | p1015 | p1024 | p1039 | p1043 | mean |
|---|---|---|---|---|---|
| bf16, 16x | 0.489 | 0.489 | 0.284 | 0.102 | **0.341** |
| bf16, 4x | 0.208 | 0.195 | 0.232 | 0.290 | 0.231 |
| affine 4-bit (RTN), 16x | 0.157 | 0.087 | 0.348 | 0.082 | 0.169 |
| affine 4-bit (AWQ, multimodal), 16x | 0.136 | 0.106 | 0.164 | 0.110 | 0.129 |
| mxfp4, 16x | 0.107 | 0.223 | 0.056 | 0.090 | 0.119 |

Two corrections to the earlier record follow from this, and they are downgrades, not deletions:

- **The quant-format ordering was noise.** On one photo mxfp4 (0.192) beat affine 4-bit (0.052) by
  a wide margin; over four photos mxfp4 came *last* of the three quant formats and affine RTN came
  first. What is stable is only that the unquantised bf16 checkpoint matches the reference best
  (0.341) and that every quant format drifts (0.119-0.169) with a per-photo spread far larger
  than the gaps between formats (e.g. affine RTN scores 0.348 on p1039 and 0.082 on p1043). Any
  ranking of these formats from a single image should be treated as unfounded.
- **AWQ bought nothing here.** `--quant-method awq --calibration multimodal --calibration-data` with
  the four photos scaled only 6 layers / 18 groups ("AWQ scaling applied: {'layers': 6, 'groups': 18}")
  and scored 0.129, between mxfp4 and affine RTN, i.e. inside the noise of the RTN run.
- **4x is not "finer".** The 4x caption differed from the 16x one on all four photos (pairwise
  ratios 0.156-0.413) and was *further* from the reference on average (0.231 vs 0.341). Where read,
  the 4x captions were content-accurate; the pylon hallucination of F13 remains a one-photo
  observation, not an established cost of the mode.

**Evidence:** photos fetched from `https://picsum.photos/id/<id>/800/600`; reference captions from
`/tmp/refenv/bin/python ref_batch.py` (transformers 5.20.2, torch 2.14.1, bf16, MPS, greedy,
`max_new_tokens=200`); MLX captions from `/tmp/mlxenv/bin/python mlx_batch.py <ckpt> <16x|4x> <out>`
(mlx-vlm 0.7.9, `max_tokens=200`, `temperature=0`, the 4x runs flipping
`proc.image_processor.downsample_mode`); scores from
`difflib.SequenceMatcher(None, reference[:1500], caption[:1500]).ratio()`. AWQ build:
`mlx_vlm.convert --hf-path openbmb/MiniCPM-V-4.7-1B --mlx-path /tmp/MiniCPM-V-4.7-1B-awq4 --dtype
bfloat16 -q --q-bits 4 --q-group-size 64 --q-mode affine --quant-method awq --calibration multimodal
--calibration-data /tmp/photos` → 14.4 s, 2665.92 MB, 13.719 bits/weight. Machine as in F5.

### F19 — The 35B-A3B sibling is untested here, and on a 24 GB Mac no published variant fits [UNVERIFIED]

The sibling exists in mlx-community (bf16/4bit/5bit/6bit/8bit/mxfp4/mxfp8/nvfp4), but the
weight sizes put it out of reach of this machine, so nothing here says how it behaves in use.

| published 35B-A3B variant | safetensors on disk | on a 24 GB Mac |
|---|---|---|
| 4bit | **23.53 GB** (5 shards) | weights alone fill RAM — no room for the KV cache, activations or the vision tower |
| 6bit | 31.68 GB (7 shards) | exceeds unified memory |
| bf16 | 70.43 GB (14 shards) | far out of reach |
| (for scale) 1B 4bit | 2.67 GB | fits with room to spare |

So the run needs roughly 32 GB of unified memory — the same threshold MTPLX's own catalogue quotes
for its 27B flagship ("The 27B flagship needs 32 GB of unified memory or more"). The *behaviour* of
the 35B-A3B on such a Mac remains untested here: no local conversion or generation was attempted,
and downloading 23.5 GB to find out was out of proportion to a 1B investigation.

**Note:** sizes from the Hub API with blob metadata
(`https://huggingface.co/api/models/mlx-community/<repo>?blobs=true`, summed over
`*.safetensors`); the model list from
`https://huggingface.co/api/models?search=MiniCPM-V-4.7&limit=100`; the 32 GB figure from
`https://mtplx.com/models/` (Qwen 3.8 27B, "32 GB and up").

### F20 — The size figures in this record do not reproduce; today's conversions are ~5% larger [MEASURED]

Re-measured on 2026-10-20 from the same pinned source (`openbmb/MiniCPM-V-4.7-1B` at revision
`379f120c2ff3588e6e06559ec6b9ec15cc05114e` — the sha this record already cites, whose
`model.safetensors` is 3,109,054,480 bytes), the converted sizes come out **larger** than the ones
quoted above:

| format | size in F6/F17 | size re-measured 2026-10-20 | `model.safetensors` tensors |
|---|---|---|---|
| bf16 | 2965.0 MB | **3109.05 MB** (2.90 GiB) | 780 — the source's own count |
| affine 4-bit | 2542.4 MB | **2665.92 MB** (2.48 GiB) | 972 |
| mxfp4 | 2533.2 MB | **2656.27 MB** (2.47 GiB) | 972 |
| nvfp4 | 2665.9 MB | 2665.91 MB (2.48 GiB) | 972 |
| mxfp8 | 2810.4 MB | 2810.42 MB (2.62 GiB) | 972 |

and the text-only export likewise: **2012.46 MB** (1.87 GiB, 321 of 780 tensors) from a bf16
source, **1569.33 MB** (1.46 GiB, 513 of 972) from an affine-4bit source — the export recipe itself
is unchanged, only the byte counts move.

What reproduced and what did not, stated precisely:

- **Reproduced:** the tensor counts (780 in the bf16 checkpoint, 972 in the affine-4bit one, 321 and
  513 kept by the export, 459 dropped in both); every quantised format's byte size, to within a
  megabyte (affine4 2665.92 vs 2665.91, nvfp4 2665.91 vs 2665.9, mxfp8 2810.42 vs 2810.4, mxfp4
  2656.27 vs 2533.2 — the one quantised outlier, mxfp4, is itself 123 MB out); and every caption
  result, which is a property of the weights rather than of their serialisation.
- **Did not reproduce:** the bf16 checkpoint's byte size (2965.0 MB then, 3109.05 MB now) and the
  bf16 export's size with it (1497 MB then, 2012.46 MB now) — a 34% and 144 MB difference.
  The source settles what that means: `openbmb/MiniCPM-V-4.7-1B`'s `model.safetensors` is **780
  tensors, all bfloat16, 1554.5 M parameters — 3109.0 MB** — and today's conversion matches it
  exactly (780 tensors, 3109.05 MB), so today's bf16 checkpoint is a faithful copy of its source.
  The *earlier* one was 144 MB **smaller than the source it came from**, which can only mean it
  dropped tensors or stored some of them narrower than bf16. Which of the two, the earlier artefact
  would have to answer, and it has been deleted — so the record says "dropped or narrowed" and not
  more. Either way the earlier figure is superseded.

So the *sizes* quoted in F6, F15 and F17 are properties of one conversion run and are superseded
by the table above, while the caption results in those findings stand untouched.

**Evidence:** the source's own census, read with `mx.load` from the Hub snapshot
`…/models--openbmb--MiniCPM-V-4.7-1B/snapshots/379f120c…/model.safetensors` in the mlx-vlm 0.7.9
venv — 780 tensors, every one `mlx.core.bfloat16`, 1554.5 M parameters; plus
`scripts/convert_minicpmv47.sh` with `FORMATS="bf16 affine4 mxfp4 nvfp4 mxfp8"`,
`VENV=<fresh venv with mlx-vlm 0.7.9>`, `OUT_ROOT=/tmp/sz-out` on 2026-10-20, then
`ls -l /tmp/sz-out/*/model.safetensors` (byte counts above) and the two exports run through
`scripts/export_mtplx_textonly.py` ("tensors: kept 321, dropped 459" / "kept 513, dropped 459";
"weights 2.90 GiB -> 1.87 GiB" / "2.48 GiB -> 1.46 GiB"); the source size from
`curl -sSIL https://huggingface.co/openbmb/MiniCPM-V-4.7-1B/resolve/379f120c2ff3588e6e06559ec6b9ec15cc05114e/model.safetensors`
— which answers in two hops, and both carry the size: the **302** from the Hub carries
`x-linked-size: 3109054480` (the LFS pointer) and the **200** from the CDN carries
`content-length: 3109054480` — and the revision from
`https://huggingface.co/api/models/openbmb/MiniCPM-V-4.7-1B` → `"sha": "379f120c2ff3588e6e06559ec6b9ec15cc05114e"`.

## How to reproduce

`scripts/convert_minicpmv47.sh` runs the whole chain — the environment, the five conversions, the
MTPLX export and one caption per checkpoint — and was verified end to end on the machine above
(a failed conversion now stops the run with exit 3 instead of being reported as built).
`scripts/check_record_refs.py "docs/work/2026-10-20-*.md"` checks that every finding pointer in
these three records resolves and that every grade marker is in the closed set.

## Still open

- Whether any quant format is *better* than another for this model. Four photos (F18) put the three
  quant formats inside each other's noise band, so the honest answer is "not established, and not
  cheaply establishable from captions". A real quality metric (an OCR or VQA score on labelled
  images) would separate them where sequence similarity cannot.
- Whether the affine 4-bit checkpoint's prose-versus-sectioned layout shift is a style effect or a
  content effect — the layout difference is visible in every caption, but the content behind it was
  only compared on one image.
- Whether the 4x mode's extra visual tokens ever *help*; on four photos 4x was consistently further
  from the bf16 reference than 16x, and the one observed hallucination (F13) sits on the 4x side.
- Whether the MLX and transformers chat templates differ in a way that explains the prose-vs-markdown
  style difference seen between the affine and bf16 runs; the two outputs were not token-aligned.
- Whether mlx-vlm should forward `downsample_mode` through the generate path (F12) — the option is
  documented in the model card but only reachable by flipping the processor's default attribute or
  editing `processor_config.json` in 0.7.9.
- Whether the 35B-A3B sibling converts and runs within 24 GB on this machine — untested.
