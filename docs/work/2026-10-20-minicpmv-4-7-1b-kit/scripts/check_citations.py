#!/usr/bin/env python3
"""Check that every source citation in the research records still points at the right line.

A citation is only as good as the file it names: upstream moves, and a line number silently
decays into a wrong claim. This script re-reads the pinned sources and verifies, for every
`file.py:NN[-MM]` citation in the records:

- the file exists at the path implied by the citation,
- the cited line (or range) exists in it,
- and where the record quotes code near the citation, that fragment is present at the cited line.

Pinned sources (edit these to match the versions the records cite):

    mlx-lm  0.31.3   — MTPLX's runtime venv (site-packages/mlx_lm)
    mlx-vlm 0.7.9    — a venv with mlx-vlm installed
    MTPLX   main     — an unpacked checkout (upstream, fetched on the citation date)

Usage:
    python check_citations.py <record.md|glob> [...]
    python check_citations.py "docs/work/2026-10-20-*.md"

Exit code 0 when every citation resolves, 1 otherwise.
"""

from __future__ import annotations

import glob
import os
import re
import sys

# where each cited tree lives
SRC = {
    "mlx_lm/models": os.path.expanduser(
        "~/Library/Application Support/MTPLX/runtime-venv/lib/python3.14/site-packages/mlx_lm/models"
    ),
    "mlx_lm/utils.py": os.path.expanduser(
        "~/Library/Application Support/MTPLX/runtime-venv/lib/python3.14/site-packages/mlx_lm/utils.py"
    ),
    "mlx_vlm/models": "/tmp/auditv/lib/python3.15/site-packages/mlx_vlm/models",
    "mlx_vlm/utils.py": "/tmp/auditv/lib/python3.15/site-packages/mlx_vlm/utils.py",
    "mlx_vlm/speculative": "/tmp/auditv/lib/python3.15/site-packages/mlx_vlm/speculative",
    "mtplx": "/tmp/auditsrc/MTPLX-main/mtplx",
}

CITATION = re.compile(r"([A-Za-z0-9_./]+\.py):(\d+)(?:-(\d+))?")
CODE = re.compile(r"`([^`]{4,90})`")


def resolve(path: str) -> str | None:
    """Map a cited path to a file on disk, using the longest matching SRC prefix."""
    candidates = [c for c in SRC if path.startswith(c)]
    if not candidates:
        return None
    root = max(candidates, key=len)
    if path == root:
        return SRC[root]
    return os.path.join(SRC[root], path[len(root) :].lstrip("/"))


def normalise(text: str) -> str:
    text = text.replace("\\n", " ").replace("python", " ")
    return re.sub(r"\s+", " ", text).strip()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    paths: list[str] = []
    for arg in argv:
        paths.extend(sorted(glob.glob(arg)) if any(c in arg for c in "*?[") else [arg])

    total = range_ok = snippet_ok = no_snippet = unresolved = 0
    problems: list[tuple[str, str, str]] = []

    for path in paths:
        text = open(path, encoding="utf-8").read()
        for m in CITATION.finditer(text):
            cited, first, last = m.group(1), int(m.group(2)), m.group(3)
            last = int(last) if last else first
            full = resolve(cited)
            if not full or not os.path.isfile(full):
                unresolved += 1
                problems.append((path, f"{cited}:{first}-{last}", "file not found at the cited path"))
                continue
            lines = open(full, encoding="utf-8", errors="replace").read().splitlines()
            if not (1 <= first <= len(lines) and last <= len(lines)):
                problems.append((path, f"{cited}:{first}-{last}", f"file has only {len(lines)} lines"))
                continue
            range_ok += 1
            total += 1
            window = text[m.end() : m.end() + 170]
            quoted = [c for c in CODE.findall(window) if ("=" in c or "def " in c or "class " in c)]
            if not quoted:
                no_snippet += 1
                continue
            fragment = normalise(re.split(r"\s*[\),]", quoted[0])[0])
            if not fragment:
                no_snippet += 1
                continue
            span = normalise("\n".join(lines[first - 1 : last]))
            near = normalise("\n".join(lines[max(0, first - 3) : first + 2]))
            if fragment in span or fragment in near:
                snippet_ok += 1
            else:
                problems.append(
                    (path, f"{cited}:{first}-{last}", f"quoted fragment not at the cited line: {fragment[:50]!r}")
                )

    print(f"citations found: {total} (file and line range verified: {range_ok})")
    print(f"  quoted fragments verified at the cited line: {snippet_ok}; nothing to check: {no_snippet}")
    print(f"  unresolved paths: {unresolved}")
    for path, cited, why in problems:
        print(f"  PROBLEM {path}: {cited} — {why}")
    print("OK — every citation resolves" if not problems else f"{len(problems)} citation problem(s)")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
