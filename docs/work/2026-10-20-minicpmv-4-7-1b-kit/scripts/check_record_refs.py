#!/usr/bin/env python3
"""Check a set of research records for stale finding references and bad grade markers.

Renumbering findings (inserting one in the middle, swapping two) silently invalidates every
"F<n>" pointer in the prose — the pointer still resolves to *a* finding, but to the wrong one.
This script prints every in-text reference next to the title of the finding it resolves to, so a
mismatch is visible at a glance.

Usage:
    python check_record_refs.py "docs/work/2026-10-20-*.md"     # every reference, with its target
    python check_record_refs.py --quiet "docs/work/2026-10-20-*.md"   # summary only

Exit code 0 when every reference resolves and every grade marker is in the closed set; 1 when a
reference points at a finding that does not exist, or a grade marker is misspelled.
"""

from __future__ import annotations

import glob
import os
import re
import sys

sys.dont_write_bytecode = True   # keep the kit free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import expand  # noqa: E402

HEADING = re.compile(r"^### (F\d+) — (.+?) \[(MEASURED|READ|INFERRED|UNVERIFIED)\]$", re.M)
# a finding-shaped heading that does not carry a grade is a defect, not a heading to skip
FINDING_SHAPED = re.compile(r"^### F\d+ — .*$", re.M)
REFERENCE = re.compile(r"(?<!### )\bF(\d+)\b")
RECORD_PATH = re.compile(r"docs/work/[\w.-]+\.md")
VALID_GRADES = {"MEASURED", "READ", "INFERRED", "UNVERIFIED"}
GRADE_TOKEN = re.compile(r"\[([A-Z][A-Z]{2,})\]")
GRADE_SLIP = re.compile(r"\b(INFERIFIED|UNVERIFED|MEASURE|MEASUREMENT|READS|READED|INFER)\b")
# Phrasings that were wrong in an earlier draft and were corrected by re-reading the
# cited source. They are guarded so the mistake cannot come back unnoticed.
KNOWN_WRONG = [
    (
        # any phrasing of the inverted claim, not just the one that was written before
        re.compile(r"patch(es)?\s+into\s+an?\s+[^.]{0,24}block of tokens", re.I),
        "inverted: one token COVERS a 4x4 block of patches at 16x, it does not expand into one",
    ),
    (
        re.compile(r"each (visual )?patch (is |becomes )?(packed|mapped|expanded)", re.I),
        "inverted: one token COVERS a block of patches, it does not expand a patch into tokens",
    ),
    (
        re.compile(r"divides the same target size by that factor", re.I),
        "the processor divides by the SQUARE of the model factor (4/16, not 2/4)",
    ),
    (
        re.compile(r"qwen3_dspark\s*→\s*\`?dflash\`?\)? is the path|via \`?qwen3_dspark", re.I),
        "the DSpark checkpoint resolves to model_type 'dspark', not 'qwen3_dspark'",
    ),
]


def load(paths: list[str]) -> dict[str, dict[int, str]]:
    records: dict[str, dict[int, str]] = {}
    for path in paths:
        text = open(path, encoding="utf-8").read()
        records[path] = {int(m.group(1)[1:]): m.group(2) for m in HEADING.finditer(text)}
    return records


def main(argv: list[str]) -> int:
    quiet = False
    if argv and argv[0] in ("--quiet", "-q"):
        quiet = True
        argv = argv[1:]
    if not argv:
        print(__doc__)
        return 2
    paths = expand(argv[0]) if len(argv) == 1 else argv[0].split()
    if not paths:
        print("no records matched — run this from the repository (or pass an explicit path)")
        return 1
    records = load(paths)
    broken = 0
    for path in paths:
        text = open(path, encoding="utf-8").read()
        own = records[path]
        if not quiet:
            print(f"== {path} ({len(own)} findings)")
        for match in REFERENCE.finditer(text):
            number = int(match.group(1))
            line_start = text.rfind("\n", 0, match.start()) + 1
            line = text[line_start : text.find("\n", match.end())].strip()
            if line.startswith("### F") or ".gguf" in line:
                continue
            if any(name in line for name in ("Q8_0", "Q4_K_M", "Q6_K", "IQ3", "IQ4", "Q5_1")):
                continue  # a GGUF quant-name list, not a finding reference
            # the record a reference points at: named in the same line, by path or by
            # "the <name> record's F<n>" phrasing
            target_record = None
            target_known = False
            named = RECORD_PATH.findall(line)
            if named:
                for candidate in records:
                    if candidate.endswith(named[-1]):
                        target_record = candidate
                        target_known = True
                        break
            else:
                for keyword, suffix in (
                    ("MLX record", "mlx-conversion"),
                    ("MTPLX record", "mtplx-format"),
                    ("runtime record", "runtime-formats"),
                ):
                    if keyword in line:
                        for candidate in records:
                            if candidate.endswith(f"{suffix}.md"):
                                target_record = candidate
                                target_known = True
                                break
                        break
            titles = records.get(target_record, own) if target_record else own
            where = target_record or path
            if target_record is None and not target_known and ("record" in line or "sibling" in line):
                # the line points at another record but we could not name it — say so
                where = f"{path} (target record not identified; checked against this one)"
            title = titles.get(number)
            if title is None:
                broken += 1
                print(f"  F{number:<3} -> MISSING in {where}")
            elif not quiet:
                print(f"  F{number:<3} -> {title[:66]}")
                print(f"        in {where}")
                print(f"        {line[:104]}")
    mix: dict[str, int] = {}
    # the kit's README must list exactly the scripts that exist beside it
    kit_dir = os.path.dirname(os.path.abspath(__file__))
    kit_readme = os.path.join(os.path.dirname(kit_dir), "README.md")
    if os.path.isfile(kit_readme):
        readme = open(kit_readme, encoding="utf-8").read()
        files_section = re.search(r"^## Files\s*$(.*?)(?=^## |\Z)", readme, re.M | re.S)
        # only the bullet lines count as "listed" — a mention inside a bullet's prose does not
        bullets = [ln for ln in (files_section.group(1).splitlines() if files_section else [])
                   if ln.lstrip().startswith("- ")]
        listed = {m for ln in bullets for m in re.findall(r"scripts/([A-Za-z0-9_]+\.(?:py|sh))", ln)}
        on_disk = {f for f in os.listdir(kit_dir) if f.endswith((".py", ".sh"))}
        for name in sorted(on_disk - listed):
            broken += 1
            print(f"\n!! {kit_readme}: scripts/{name} exists but is not listed")
        for name in sorted(listed - on_disk):
            broken += 1
            print(f"\n!! {kit_readme}: scripts/{name} is listed but does not exist")

    for path in paths:
        text = open(path, encoding="utf-8").read()
        bad = {m.group(1) for m in GRADE_TOKEN.finditer(text)} - VALID_GRADES
        slips = set(GRADE_SLIP.findall(text))
        if bad or slips:
            broken += 1
            print(f"\n!! {path}: invalid grade marker(s) {sorted(bad)}" if bad else "", end="")
            print(f" grade-like slip(s) {sorted(slips)}" if slips else "")
        for pattern, why in KNOWN_WRONG:
            if pattern.search(text):
                broken += 1
                print(f"\n!! {path}: known-wrong phrasing — {why}")
        # every finding-shaped heading must carry a grade from the closed set
        strict = {m.group(0) for m in HEADING.finditer(text)}
        for heading in FINDING_SHAPED.finditer(text):
            if heading.group(0) not in strict:
                broken += 1
                print(f"\n!! {path}: finding heading without a grade marker — {heading.group(0)[:80]!r}")
        # grade mix, counted from the finding headings only
        counts: dict[str, int] = {}
        for m in HEADING.finditer(text):
            grade = m.group(3)
            counts[grade] = counts.get(grade, 0) + 1
            mix[grade] = mix.get(grade, 0) + 1
        # the skill's checklist: an empty "Still open" must be defended, so flag it
        still_open = re.search(r"^## Still open\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
        if not (still_open and still_open.group(1).strip()):
            broken += 1
            print(f"\n!! {path}: the '## Still open' section is empty or missing")
        if not quiet:
            print(f"   grades: {counts}  findings: {sum(counts.values())}")
    if not quiet:
        print(f"\n   total: {mix}  findings: {sum(mix.values())}")
    if broken:
        print(f"\n{broken} problem(s)")
    else:
        print(
            "\nOK — checked: every finding pointer resolves into the right record; every finding carries a\n"
            "     grade from the closed set {MEASURED, READ, INFERRED, UNVERIFIED}; no grade-like slip;\n"
            "     every '## Still open' section is non-empty; no known-wrong phrasing present; the kit's\n     README lists exactly the scripts that exist beside it."
        )
    return 0 if not broken else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
