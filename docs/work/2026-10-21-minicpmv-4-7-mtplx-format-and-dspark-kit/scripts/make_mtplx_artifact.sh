#!/usr/bin/env bash
# Build a MiniCPM-V 4.7 MLX checkpoint into an MTPLX artifact: the text-tower export plus the
# `mtplx_runtime.json` contract, then prove MTPLX accepts it.
#
# MiniCPM-V 4.7's text tower is a Qwen3.5 text model, and MTPLX's loader resolves a checkpoint's
# top-level `model_type` against mlx-lm's module registry — so `minicpmv4_7` is refused
# ("ValueError: Model type minicpmv4_7 not supported"). Exporting the text tower alone (keeping the
# `language_model.*` tensors and rewriting config.json to `model_type: qwen3_5`) gives a directory
# MTPLX loads; adding the runtime contract makes it an MTPLX *artifact* in the format MTPLX
# publishes (MLX trunk + `mtp.safetensors` sidecar + `mtplx_runtime.json`), minus the sidecar,
# which cannot exist for this model — it has no MTP head, and MTPLX's Forge cannot create one.
#
# Measured on an Apple M4 MacBook Air (24 GB, macOS 27.0.1) with MTPLX 2.12.2 and mlx-vlm 0.7.9.
# The evidence is in docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark.md.
#
# Usage:
#   bash make_mtplx_artifact.sh <src-mlx-dir> <dst-dir>
#   bash make_mtplx_artifact.sh --help
#
# Environment overrides:
#   VENV     python environment holding mlx-vlm (default $HOME/.venvs/minicpmv47)
#   MTPLX    the mtplx CLI (default: whatever is on PATH)
#   BASE_TRUNK  the checkpoint the export came from, recorded in the contract
#               (default openbmb/MiniCPM-V-4.7-1B)
#
# Exit codes: 0 the artifact was built and MTPLX accepted it, 2 bad usage, 3 a step failed.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
EXPORT_SCRIPT="$REPO/docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts/export_mtplx_textonly.py"
CONTRACT_SCRIPT="$HERE/write_mtplx_runtime_contract.py"

VENV="${VENV:-$HOME/.venvs/minicpmv47}"
MTPLX="${MTPLX:-mtplx}"
BASE_TRUNK="${BASE_TRUNK:-openbmb/MiniCPM-V-4.7-1B}"

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

SRC="$1"
DST="$2"
PY="$VENV/bin/python"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[31merror: %s\033[0m\n' "$*" >&2; exit "${2:-3}"; }

[ -d "$SRC" ] || die "no such source directory: $SRC"
[ -f "$SRC/config.json" ] || die "$SRC has no config.json — is it an mlx_vlm.convert output?"
[ -x "$PY" ] || die "no python at $PY (set VENV) — mlx-vlm is needed for the export"
[ -f "$EXPORT_SCRIPT" ] || die "missing the export script: $EXPORT_SCRIPT"

say "1/3 export the text tower (drop vision + merger tensors, model_type -> qwen3_5)"
"$PY" "$EXPORT_SCRIPT" "$SRC" "$DST" || die "the text-only export failed"

say "2/3 write the mtplx_runtime.json contract"
"$PY" "$CONTRACT_SCRIPT" "$DST" --base-trunk "$BASE_TRUNK" --force \
  || die "writing the contract failed"

say "3/3 let MTPLX check the artifact"
if ! command -v "$MTPLX" >/dev/null 2>&1; then
  warn "no '$MTPLX' on PATH — skipping the MTPLX check"
  exit 0
fi
"$MTPLX" inspect --model "$DST" --json > "$DST/../$(basename "$DST")-inspect.json" \
  || warn "mtplx inspect exited non-zero (its exit code reports the tier, not the run)"
"$PY" - "$DST/../$(basename "$DST")-inspect.json" <<'PYEOF' || die "MTPLX did not accept the artifact"
import json, sys
report = json.load(open(sys.argv[1]))
compat = report.get("compatibility", {})
print("    contract_error:", compat.get("runtime_contract_error"))
print("    can_run:", compat.get("can_run"), "| tier:", compat.get("tier"),
      "| mtp_supported:", compat.get("mtp_supported"))
if compat.get("runtime_contract_error"):
    raise SystemExit(1)
PYEOF

say "done — the artifact is $DST"
echo "    serve it:  $MTPLX serve --model $DST --port 8123 --host 127.0.0.1 --no-auth"
