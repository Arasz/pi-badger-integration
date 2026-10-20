#!/usr/bin/env bash
# Convert openbmb/MiniCPM-V-4.7-1B into MLX checkpoints, an MTPLX-loadable text-only
# export, and verify each one with a generated caption.
#
# Everything here was measured on an Apple M4 MacBook Air (24 GB, macOS 27.0.1, Python 3.15)
# with mlx 0.32.4 / mlx-vlm 0.7.9. The evidence for every step is in
# docs/work/2026-10-20-minicpmv-4-7-1b-mlx-conversion.md (and the MTPLX part in
# docs/work/2026-10-20-mtplx-format-for-minicpmv.md).
#
# Usage:
#   ./convert_minicpmv47.sh                        # all formats, export, verify
#   ./convert_minicpmv47.sh --help
#   FORMATS="bf16 affine4" ./convert_minicpmv47.sh  # only these formats
#   OUT_ROOT=~/models/mc47 VENV=~/venvs/mc47 ./convert_minicpmv47.sh
#
# Environment overrides:
#   MODEL_ID   source repo id                (default openbmb/MiniCPM-V-4.7-1B)
#   OUT_ROOT   where checkpoints are written  (default $HOME/models/minicpmv47)
#   VENV       python environment to create   (default $HOME/.venvs/minicpmv47)
#   FORMATS    space-separated format names   (default "bf16 affine4 mxfp4 nvfp4 mxfp8")
#   DO_EXPORT  1|0 — build the MTPLX export  (default 1)
#   DO_VERIFY  1|0 — caption each checkpoint (default 1)
#
# Exit codes: 0 everything built and verified, 2 bad usage, 3 a conversion or the
# export failed (the script stops at the first failure — it never reports success over
# a checkpoint that was not produced).

set -euo pipefail

MODEL_ID="${MODEL_ID:-openbmb/MiniCPM-V-4.7-1B}"
OUT_ROOT="${OUT_ROOT:-$HOME/models/minicpmv47}"
VENV="${VENV:-$HOME/.venvs/minicpmv47}"
FORMATS="${FORMATS:-bf16 affine4 mxfp4 nvfp4 mxfp8}"
DO_EXPORT="${DO_EXPORT:-1}"
DO_VERIFY="${DO_VERIFY:-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PY="$VENV/bin/python"
MLX_VLM_CONVERT="$VENV/bin/mlx_vlm.convert"
MLX_VLM_GENERATE="$VENV/bin/mlx_vlm.generate"
HF_HUB_DIR="${HF_HOME:-$HOME/.cache/huggingface}/hub"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit "${2:-3}"; }

# ---------------------------------------------------------------- 1. environment
say "1/5 python environment ($VENV)"
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "mlx-vlm==0.7.9"
"$PY" - <<'PYEOF'
import importlib.metadata as md
print("mlx", md.version("mlx"), "| mlx-vlm", md.version("mlx-vlm"))
PYEOF
[ -x "$MLX_VLM_CONVERT" ]  || die "missing $MLX_VLM_CONVERT" 3
[ -x "$MLX_VLM_GENERATE" ] || die "missing $MLX_VLM_GENERATE" 3

# ------------------------------------------------- 2. make the HF cache writable
# huggingface_hub writes cache blobs read-only (444). mlx_vlm.convert copies that mode
# into the output directory and then transformers rewrites tokenizer.json in place, which
# dies with "Exception: Permission denied (os error 13)". Reproduced on a pristine cache.
say "2/5 making the Hugging Face cache writable ($HF_HUB_DIR)"
mkdir -p "$HF_HUB_DIR"
chmod -R u+w "$HF_HUB_DIR" 2>/dev/null || warn "could not chmod $HF_HUB_DIR — a conversion may fail with EACCES"

# ------------------------------------------------------------------ 3. conversions
# The converter prints "Quantized model with N bits per weight"; the effective bit rate
# is high (13.6-14.5) because the vision tower, mergers, embeddings and output head stay
# BF16 in every format.
#
# convert_one <name> [flags…] — converts into $OUT_ROOT/MiniCPM-V-4.7-1B-<name> and sets
# CONVERTED_DIR. It returns the converter's exit status: a failed conversion must stop
# the run, never be reported as a built checkpoint.
CONVERTED_DIR=""
convert_one() {
  local name="$1"; shift
  local out="$OUT_ROOT/MiniCPM-V-4.7-1B-$name"
  say "3/5 convert: $name"
  echo "    $MLX_VLM_CONVERT --hf-path $MODEL_ID --mlx-path $out --dtype bfloat16 $*"
  if ! "$MLX_VLM_CONVERT" --hf-path "$MODEL_ID" --mlx-path "$out" --dtype bfloat16 "$@"; then
    die "conversion '$name' failed (see the traceback above); nothing downstream was built"
  fi
  [ -f "$out/config.json" ] || die "conversion '$name' produced no config.json in $out"
  CONVERTED_DIR="$out"
}

mkdir -p "$OUT_ROOT"
built=()
for fmt in $FORMATS; do
  case "$fmt" in
    bf16)    convert_one bf16 ;;
    affine4) convert_one affine4 -q --q-bits 4 --q-group-size 64 --q-mode affine ;;
    mxfp4)   convert_one mxfp4 -q --q-bits 4 --q-mode mxfp4 ;;
    nvfp4)   convert_one nvfp4 -q --q-bits 4 --q-mode nvfp4 ;;
    mxfp8)   convert_one mxfp8 -q --q-bits 8 --q-group-size 32 --q-mode mxfp8 ;;
    *) die "unknown format '$fmt' (known: bf16 affine4 mxfp4 nvfp4 mxfp8)" 2 ;;
  esac
  built+=("$CONVERTED_DIR")
done

# ------------------------------------------------------------- 4. MTPLX export
# MTPLX resolves the checkpoint's top-level model_type against mlx-lm's module registry,
# so `minicpmv4_7` is rejected ("ValueError: Model type minicpmv4_7 not supported").
# MiniCPM-V 4.7's text tower is a Qwen3.5 text model, so exporting the language_model.*
# tensors alone (and rewriting config.json) gives a directory MTPLX runs AR-only.
if [ "$DO_EXPORT" = "1" ]; then
  say "4/5 MTPLX text-only export"
  src=""
  for candidate in "$OUT_ROOT/MiniCPM-V-4.7-1B-bf16" "$OUT_ROOT/MiniCPM-V-4.7-1B-affine4" \
                   "$OUT_ROOT/MiniCPM-V-4.7-1B-mxfp4"; do
    [ -d "$candidate" ] && { src="$candidate"; break; }
  done
  [ -n "$src" ] || die "no converted checkpoint to export (build one first)"
  export_out="$OUT_ROOT/MiniCPM-V-4.7-1B-textonly"
  echo "    $PY $HERE/export_mtplx_textonly.py $src $export_out"
  "$PY" "$HERE/export_mtplx_textonly.py" "$src" "$export_out" \
    || die "the MTPLX export failed (see the traceback above)"
  "$PY" - "$export_out/config.json" <<'PYEOF' || die "the export's config.json is not a qwen3_5 config"
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg.get("model_type") == "qwen3_5", cfg.get("model_type")
assert "text_config" in cfg
print("    export config: model_type=qwen3_5, text_config present")
PYEOF
fi

# ------------------------------------------------------------------- 5. verify
# A synthetic image is generated on the fly, so the check needs no download and no
# photo: a blue square with a yellow circle and a red triangle.
if [ "$DO_VERIFY" = "1" ]; then
  say "5/5 verify each checkpoint with one caption"
  IMG="$OUT_ROOT/_verify.png"
  "$PY" - "$IMG" <<'PYEOF'
import sys
from PIL import Image, ImageDraw
im = Image.new("RGB", (512, 512), (30, 90, 200))
d = ImageDraw.Draw(im)
d.ellipse((100, 100, 412, 412), fill=(240, 190, 60))
d.polygon([(220, 290), (292, 290), (256, 340)], fill=(200, 40, 40))
im.save(sys.argv[1])
PYEOF
  for dir in "${built[@]}"; do
    [ -d "$dir" ] || continue
    printf '\n--- %s\n' "$(basename "$dir")"
    if "$MLX_VLM_GENERATE" --model "$dir" --image "$IMG" \
         --prompt "Describe this image in one sentence." --max-tokens 48 --temperature 0; then
      echo "    [ok] $(basename "$dir")"
    else
      die "verification failed for $dir"
    fi
  done
  rm -f "$IMG"
fi

say "done — outputs under $OUT_ROOT"
du -sh "$OUT_ROOT"/* 2>/dev/null || true
