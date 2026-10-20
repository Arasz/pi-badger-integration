"""Shared paths for the record checkers.

One implementation, two users: `check_record_refs.py` and `check_citations.py` both need to
turn a repo-relative glob into a file list, from wherever the reader happens to run them.
"""

from __future__ import annotations

import glob as _glob
import os

# Where the pinned sources live, for the citation checker. Point these at your own copies:
#   mlx-lm  0.31.3  — MTPLX's runtime venv
#   mlx-vlm 0.7.9   — a venv with mlx-vlm installed
#   MTPLX    main    — an unpacked upstream checkout
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


def repo_root(start: str | None = None) -> str:
    """The repository root above `start`.

    Defaults to this module's own location, not the working directory: the kit lives inside
    the repository, and the paths its records cite are relative to the repository root, so
    running a checker from another directory must still resolve them.
    """
    root = os.path.abspath(start or os.path.dirname(os.path.abspath(__file__)))
    for _ in range(8):
        if os.path.exists(os.path.join(root, ".git")):   # a directory or a worktree file
            return root
        parent = os.path.dirname(root)
        if parent == root:
            break
        root = parent
    return root


def expand(pattern: str) -> list[str]:
    """Expand a glob, falling back to the repository root.

    The records live at the repo root, so `docs/work/…` only matches there; a reader who
    runs a checker from inside the kit folder should not have to know that.
    """
    hits = sorted(_glob.glob(pattern))
    if hits:
        return hits
    return sorted(_glob.glob(os.path.join(repo_root(), pattern)))
