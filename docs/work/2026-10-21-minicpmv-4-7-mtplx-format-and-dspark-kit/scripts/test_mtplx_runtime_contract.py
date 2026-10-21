#!/usr/bin/env python3
"""Tests for write_mtplx_runtime_contract.py.

The validator below re-implements MTPLX 2.12.2's own contract rules
(mtplx/backends/registry.py:653-690): six required keys, `verified_on` and
`exactness_baseline` must be objects, `mtp_depth_max` must be positive, and
`recommended_generation_mode` must be "mtp" or "ar". The tests below are what make the
script's claim checkable: a contract that MTPLX would reject must fail the local validator too.

Run:
    PYTHONDONTWRITEBYTECODE=1 python3 -m pytest <this dir> -q
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from write_mtplx_runtime_contract import (  # noqa: E402
    CONTRACT_NAME,
    REQUIRED_KEYS,
    build_contract,
    write_contract,
)


def validate_like_mtplx(contract: dict) -> None:
    """Raise ValueError exactly where MTPLX's RuntimeContract.from_dict would."""
    missing = [key for key in REQUIRED_KEYS if key not in contract]
    if missing:
        raise ValueError(f"runtime contract missing required keys: {', '.join(missing)}")
    if not isinstance(contract["verified_on"], dict):
        raise ValueError("runtime contract verified_on must be an object")
    if not isinstance(contract["exactness_baseline"], dict):
        raise ValueError("runtime contract exactness_baseline must be an object")
    if int(contract["mtp_depth_max"]) <= 0:
        raise ValueError("runtime contract mtp_depth_max must be positive")
    mode = contract.get("recommended_generation_mode")
    if mode is not None and mode not in ("mtp", "ar"):
        raise ValueError("runtime contract recommended_generation_mode must be 'mtp' or 'ar'")


def test_built_contract_passes_the_mtplx_rules():
    validate_like_mtplx(build_contract("openbmb/MiniCPM-V-4.7-1B"))


def test_built_contract_declares_ar_mode_and_no_sidecar():
    contract = build_contract("openbmb/MiniCPM-V-4.7-1B")
    assert contract["recommended_generation_mode"] == "ar"
    assert contract["mtp_sidecar"] == "none"
    assert contract["mtp_depth_max"] > 0


def test_the_check_catches_a_contract_mtplx_would_reject():
    """A contract MTPLX rejects must fail the same local validator."""
    broken = build_contract("openbmb/MiniCPM-V-4.7-1B")
    broken["mtp_depth_max"] = 0
    with pytest.raises(ValueError, match="mtp_depth_max must be positive"):
        validate_like_mtplx(broken)

    broken = build_contract("openbmb/MiniCPM-V-4.7-1B")
    del broken["verified_on"]
    with pytest.raises(ValueError, match="missing required keys: verified_on"):
        validate_like_mtplx(broken)


def test_write_contract_creates_the_file_and_refuses_to_clobber(tmp_path):
    model_dir = tmp_path / "model"
    model_dir.mkdir()

    path = write_contract(str(model_dir), "openbmb/MiniCPM-V-4.7-1B")
    assert os.path.basename(path) == CONTRACT_NAME
    written = json.loads((model_dir / CONTRACT_NAME).read_text())
    validate_like_mtplx(written)

    # A second call must not overwrite without --force.
    (model_dir / CONTRACT_NAME).write_text(json.dumps({"sentinel": True}))
    write_contract(str(model_dir), "openbmb/MiniCPM-V-4.7-1B")
    assert json.loads((model_dir / CONTRACT_NAME).read_text()) == {"sentinel": True}

    write_contract(str(model_dir), "openbmb/MiniCPM-V-4.7-1B", force=True)
    validate_like_mtplx(json.loads((model_dir / CONTRACT_NAME).read_text()))
