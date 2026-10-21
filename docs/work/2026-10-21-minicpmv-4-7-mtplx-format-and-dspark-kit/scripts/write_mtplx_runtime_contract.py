#!/usr/bin/env python3
"""Write the `mtplx_runtime.json` contract that turns an MLX model directory into an MTPLX artifact.

A real MTPLX artifact is an MLX trunk plus the model's own MTP head as a standalone
`mtp.safetensors` sidecar plus an `mtplx_runtime.json` contract (see
docs/work/2026-10-21-minicpmv-4-7-mtplx-format-and-dspark.md, finding F1).

MiniCPM-V 4.7 has no MTP head and Forge cannot create one, so the contract this script writes
describes an **AR-only** artifact: `recommended_generation_mode: "ar"`, no `mtp.safetensors`
sidecar. Two contract rules drive the shape (MTPLX 2.12.2, mtplx/backends/registry.py:653-690):

  * six keys are required — mtplx_version, arch_id, mtp_depth_max, recommended_profile,
    exactness_baseline, verified_on — and `verified_on` / `exactness_baseline` must be objects;
  * `mtp_depth_max` must be **positive**, even for an AR artifact, so it is written as 1 and
    `mtp_sidecar` says "none" to say plainly that no draft head exists.

A contract that omits `recommended_generation_mode` makes MTPLX try to inject an MTP head and
fail the load ("MTP injection failed"); with it, the same directory serves AR-only.

Usage:
    python3 write_mtplx_runtime_contract.py <model-dir> [--base-trunk REPO] [--force]

The contract is rewritten in place; without --force an existing contract is left alone.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

CONTRACT_NAME = "mtplx_runtime.json"

REQUIRED_KEYS = (
    "mtplx_version",
    "arch_id",
    "mtp_depth_max",
    "recommended_profile",
    "exactness_baseline",
    "verified_on",
)


def build_contract(
    base_trunk: str,
    arch_id: str = "qwen3-next-mtp",
    mtplx_version: str = "2.12.2",
    profile: str = "sustained",
    machine: str = "Apple M4 MacBook Air 24GB",
    source_repo: str = "openbmb/MiniCPM-V-4.7-1B",
) -> dict:
    """Build an AR-only runtime contract. `mtp_depth_max` is 1 because MTPLX rejects 0."""
    now = datetime.datetime.now().astimezone().isoformat()
    return {
        "arch_id": arch_id,
        "artifact_role": "forge-local",
        "base_trunk": base_trunk,
        "exactness_baseline": {
            "source": "mlx_vlm.convert",
            "note": (
                "AR-only artifact: the model has no MTP head, so there is no mtp.safetensors "
                "sidecar and speculative decoding is unavailable (mode=AR, mtp_depth=0)."
            ),
        },
        "forge_provenance": {
            "forge_inputs": {"trunk_path": os.path.abspath(base_trunk)},
            "forge_recipe": {
                "body_bits": 16,
                "body_mode": "bf16",
                "mtp_policy": "absent",
            },
            "forged_at": now,
            "forged_locally": True,
            "mtplx_version": mtplx_version,
            "published_to_hf": None,
            "source_format": "mlx_vlm_convert",
            "source_repo": source_repo,
        },
        "mtp_depth_max": 1,
        "mtp_sidecar": "none",
        "mtplx_version": mtplx_version,
        "recommended_generation_mode": "ar",
        "recommended_generation_mode_reason": (
            "The model ships no MTP head and MTPLX's Forge cannot create one; the artifact is "
            "served autoregressively."
        ),
        "recommended_profile": profile,
        "sampler": {"temperature": 0.6, "top_k": 20, "top_p": 0.95},
        "verified_on": {
            "machine": machine,
            "model": base_trunk,
            "verified_at": now,
        },
    }


def write_contract(model_dir: str, base_trunk: str, force: bool = False) -> str:
    """Write the contract into `model_dir`; return the path written."""
    path = os.path.join(model_dir, CONTRACT_NAME)
    if os.path.exists(path) and not force:
        print(f"{path} already exists (use --force to overwrite)")
        return path
    contract = build_contract(base_trunk)
    missing = [key for key in REQUIRED_KEYS if key not in contract]
    if missing:  # pragma: no cover - guards a typo in the builder above
        raise SystemExit(f"contract would be invalid, missing keys: {missing}")
    with open(path, "w") as handle:
        json.dump(contract, handle, indent=2)
        handle.write("\n")
    print(f"wrote {path}")
    return path


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("model_dir", help="the MLX model directory to make into an MTPLX artifact")
    parser.add_argument(
        "--base-trunk",
        default="openbmb/MiniCPM-V-4.7-1B",
        help="the checkpoint the artifact was converted from (recorded in the contract)",
    )
    parser.add_argument("--force", action="store_true", help="overwrite an existing contract")
    args = parser.parse_args(argv)

    if not os.path.isdir(args.model_dir):
        print(f"not a directory: {args.model_dir}", file=sys.stderr)
        return 2
    write_contract(args.model_dir, args.base_trunk, force=args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
