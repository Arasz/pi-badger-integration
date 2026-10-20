"""Tests for the record checkers that guard these research records.

`check_record_refs.py` is the tool that keeps the records honest (finding pointers, grade
markers, the `## Still open` section, known-wrong phrasings, referenced script paths). It
therefore needs its own tests — otherwise "the checker passes" is an assertion, not a result.

Run them with:

    PYTHONDONTWRITEBYTECODE=1 python3 -m pytest docs/work/2026-10-20-minicpmv-4-7-1b-kit/scripts -q
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import _kit_paths  # noqa: E402  (the shared path helper)

spec = importlib.util.spec_from_file_location("check_record_refs", SCRIPTS / "check_record_refs.py")
assert spec and spec.loader
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

GOOD_RECORD = """# Research: a fixture record

**Date:** 2026-10-20
**Question:** Does the checker accept a well-formed record?

## Findings

### F1 — A finding with a grade and an evidence line [MEASURED]

The claim, with the command that produced it.

**Evidence:** `python3 -m pytest -q` in the repo, on the machine in the Conditions block.

### F2 — A second finding that points at the first [READ]

The claim, citing F1.

**Evidence:** `docs/work/2026-10-20-test.md` in this fixture, and the source it names.

## Still open

- Something that is still open, and what would settle it.
"""


def _write(root: Path, body: str, name: str = "2026-10-20-test.md") -> Path:
    target = root / "docs" / "work"
    target.mkdir(parents=True, exist_ok=True)
    path = target / name
    path.write_text(body, encoding="utf-8")
    return path


def _run(root: Path) -> tuple[int, str]:
    """Run the checker over the fixture tree, capturing what it prints."""
    import io
    from contextlib import redirect_stdout

    buffer = io.StringIO()
    cwd = os.getcwd()
    os.chdir(root)
    try:
        with redirect_stdout(buffer):
            code = checker.main([str(root / "docs" / "work" / "*.md")])
    finally:
        os.chdir(cwd)
    return code, buffer.getvalue()


def test_a_well_formed_record_passes(tmp_path: Path) -> None:
    _write(tmp_path, GOOD_RECORD)
    code, output = _run(tmp_path)
    assert code == 0, output
    assert "OK" in output


def test_a_pointer_to_a_missing_finding_fails(tmp_path: Path) -> None:
    _write(tmp_path, GOOD_RECORD + "\nSee F9 for the rest.\n")
    code, output = _run(tmp_path)
    assert code == 1
    assert "MISSING" in output


def test_a_finding_without_a_grade_fails(tmp_path: Path) -> None:
    body = GOOD_RECORD.replace(
        "### F2 — A second finding that points at the first [READ]",
        "### F2 — A second finding that points at the first",
    )
    _write(tmp_path, body)
    code, output = _run(tmp_path)
    assert code == 1
    assert "without a grade marker" in output


def test_an_empty_still_open_section_fails(tmp_path: Path) -> None:
    body = GOOD_RECORD.replace(
        "- Something that is still open, and what would settle it.\n", ""
    )
    _write(tmp_path, body)
    code, output = _run(tmp_path)
    assert code == 1
    assert "Still open" in output


def test_a_known_wrong_phrasing_fails(tmp_path: Path) -> None:
    body = GOOD_RECORD.replace(
        "The claim, citing F1.",
        "The claim: each patch is packed into a 4x4 block of tokens.",
    )
    _write(tmp_path, body)
    code, output = _run(tmp_path)
    assert code == 1
    assert "known-wrong phrasing" in output


def test_a_referenced_script_that_does_not_exist_fails(tmp_path: Path) -> None:
    body = GOOD_RECORD.replace(
        "`docs/work/2026-10-20-test.md` in this fixture, and the source it names.",
        "`docs/work/2026-10-20-test.md` and `docs/work/2026-10-20-test/scripts/convert_minicpmv47.sh`.",
    )
    _write(tmp_path, body)
    code, output = _run(tmp_path)
    assert code == 1
    assert "does not exist" in output


def test_expand_finds_a_glob_relative_to_the_cwd(tmp_path: Path) -> None:
    _write(tmp_path, GOOD_RECORD)
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        hits = _kit_paths.expand("docs/work/2026-10-20-*.md")
    finally:
        os.chdir(cwd)
    assert hits and hits[0].endswith("2026-10-20-test.md")
