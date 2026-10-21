# MiniCPM-V 4.7 → MTPLX artifact, and the DSpark draft

The runnable part of the 2026-10-21 investigation. The evidence — commands, machine, conditions —
is in the record one directory up:

- `docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark.md` — the findings (17)
- `docs/work/2026-10-20-minicpmv-4-7-1b-kit/` — the MLX conversions and the text-tower export
  (the export script this kit reuses)

Everything here was measured on an **Apple M4 MacBook Air, 24 GB RAM, macOS 27.0.1**, with
**MTPLX 2.12.2** (mlx 0.32.2, mlx-lm 0.31.3), **mlx-vlm 0.7.9** (mlx 0.32.4, Python 3.15.0), and
llama.cpp built from `master` (Metal).

## What an "MTPLX artifact" turned out to be

A published MTPLX model is a directory of: the MLX trunk (`config.json`, `model.safetensors` +
index), the model's own **MTP head as a standalone `mtp.safetensors` sidecar**, and an
**`mtplx_runtime.json` contract**. MiniCPM-V 4.7 has no MTP head and MTPLX's Forge cannot create
one — so the artifact this kit builds has the trunk and the contract, and no sidecar:

- the trunk is the **text tower** (MiniCPM-V 4.7's text model is a Qwen3.5 text model, which
  mlx-lm's `qwen3_5` module loads tensor-for-tensor), so the artifact is **text-only**;
- the contract declares `recommended_generation_mode: "ar"`, so MTPLX serves it autoregressively
  instead of trying to inject a draft head that does not exist.

Two contract rules catch people out, and both are enforced by the runtime
(`mtplx/backends/registry.py:653-690`):

- six keys are required — `mtplx_version`, `arch_id`, `mtp_depth_max`, `recommended_profile`,
  `exactness_baseline`, `verified_on` — and `verified_on` / `exactness_baseline` must be
  **objects**, not strings;
- `mtp_depth_max` must be **positive**, even for an AR-only artifact. This kit writes `1` and
  `mtp_sidecar: "none"` to say plainly that no draft head exists.

A contract that omits `recommended_generation_mode` makes `mtplx run` fail with
`RuntimeError: MTP injection failed` — measured, not guessed.

## One command for the artifact

```bash
bash docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark-kit/scripts/make_mtplx_artifact.sh \
  ~/models/minicpmv47/MiniCPM-V-4.7-1B-bf16 \
  ~/models/minicpmv47/MiniCPM-V-4.7-1B-mtplx
```

It exports the text tower, writes the contract, and then lets MTPLX check the result:

```
==> 3/3 let MTPLX check the artifact
    contract_error: None
    can_run: True | tier: architecture-compatible-but-unverified | mtp_supported: no
```

Then serve it with the installed server:

```bash
mtplx serve --model ~/models/minicpmv47/MiniCPM-V-4.7-1B-mtplx --port 8123 --host 127.0.0.1 --no-auth
curl -s http://127.0.0.1:8123/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"<the served model id>","messages":[{"role":"user","content":"Say hello in exactly three words."}],"max_tokens":256,"reasoning":"off"}'
```

Measured: **54.1 tok/s** AR on the M4, OpenAI and Anthropic dialects both answered. Note that
without `"reasoning":"off"` the MiniCPM thinking block consumes the whole `max_tokens` budget and
`content` comes back empty.

## The DSpark draft, on this machine

The draft is a **separate checkpoint** (`Qwen3DSparkModel`, 5 layers, 15 proposals per pass),
trained against the target's hidden states — not an MTP head, so it cannot be turned into
`mtp.safetensors`.

| runtime | draft support | measured on this M4 |
|---|---|---|
| mlx-vlm | generic DSpark drafter, `--draft-model … --draft-kind dflash` | works, exact — but **1.9× slower than AR** on the 1B (36.9 vs 69.2 tok/s) |
| llama.cpp | `--spec-type draft-dspark -md <drafter>.gguf` | works, exact — **~38 % slower than AR** on the 35B-A3B for prose (20.3 vs 32.7 tok/s); a wash for code |
| MTPLX | none — no generic draft-model path (the only external-assistant mechanism is Gemma-4-specific) | n/a |

The llama.cpp recipe (needs a build from `master`; the Homebrew 0.7.0 binary has neither
`dspark` nor `minicpm` in it):

```bash
llama-server \
  -m  MiniCPM-V-4_7-35B-A3B-mix_q3gud_im.gguf \
  --mmproj mmproj-model-f16.gguf \
  -md dspark-MiniCPM-V-4_7-35B-A3B-Q8_0.gguf \
  --spec-type draft-dspark --spec-draft-n-max 4 \
  -c 8192 --jinja --port 8080 --host 127.0.0.1
```

Two practical traps, both measured:

- **one 35B server at a time.** A second one dies with Metal `Insufficient Memory`, and the
  running one then fails with `decode: Compute error`.
- **`--spec-draft-n-max` is a cost knob, not a speed knob.** Going from 4 to 15 halved the
  throughput (20.3 → 9.2 tok/s) without improving acceptance.

The acceptance shortfall is **not** caused by the target's quantization: with a higher-precision
target (`IQ4_XS`, 18.7 GB) the acceptance is the same (1.46 accepted tokens per verification step
on prose, 3.60 on code, against 1.48 / 3.50 with the IQ3-mix target), and the draft is still a
loss. See the record's F17.

## Files

- `scripts/make_mtplx_artifact.sh` — export + contract + MTPLX check, in one command
- `scripts/write_mtplx_runtime_contract.py` — writes a valid AR-mode `mtplx_runtime.json`
- `scripts/test_mtplx_runtime_contract.py` — the contract writer's tests, including a check that
  reproduces MTPLX's own validation rules (so a contract MTPLX would reject fails the test too)

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark-kit/scripts -q
```
