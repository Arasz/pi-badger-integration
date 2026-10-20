# Research: a `git reset` in a shared checkout silently rewinds another branch

**Date:** 2026-10-20
**Question:** What happens to a branch that is checked out in a shared working tree when another session runs `git reset --hard` there, and how do you get the branch back?

**Short answer:** the branch is rewound too, and the reflog is how you get it back. This repo has
several agent sessions working in parallel against one `main` checkout, so the hazard is real here,
not hypothetical. The rule that removes it: **do not branch, reset or commit in the shared
checkout — work in a dedicated `git worktree`**.

## Findings

### F1 — `git reset --hard origin/main` moved a *different* branch's ref, not just the checked-out one [MEASURED]

The work happened on this repository's shared `main` checkout. A parallel session ran
`git reset --hard origin/main` there; at that moment my branch was the one checked out, so git
rewound **that branch's ref** as well — seven of my commits left the branch tip while the working
tree was untouched. I noticed it a few steps later, when a commit's parent was not the commit I
had just made.

The branch's reflog records the event, and the branch still carries it:

```
docs/minicpmv-4-7-mlx-conversion-research@{23}: reset: moving to origin/main
docs/minicpmv-4-7-mlx-conversion-research@{102}: branch: Reset to e173643
docs/minicpmv-4-7-mlx-conversion-research@{103}: reset: moving to origin/main
```

120 reflog entries remained on the branch, so every rewound commit was still reachable.

**Evidence:** `git reflog show docs/minicpmv-4-7-mlx-conversion-research` (2026-10-20, this
repository) — the three lines above; the branch's own history before the reset carried the commits
that were lost from its tip.

### F2 — The recovery is the reflog, and the branch comes back intact [MEASURED]

Nothing was lost. The rewound commits were recovered from the reflog and the branch was restored,
then rebased onto the current `origin/main`:

```bash
git reflog show <branch>                     # find the last good sha
git branch -f <branch> <sha>                # move the branch back
git rebase origin/main                       # replay it on the current base
```

The recovered history produced the same content (three records, a conversion kit, a docs index
line), and the branch then went on to 26 commits and a draft PR.

**Evidence:** the branch's reflog entries quoted in F1, the restored commit
`docs/minicpmv-4-7-mlx-conversion-research@e173643` ("docs(work): carry the export script
verbatim so the record can be diffed"), and the rebased tip.

### F3 — A worktree is not a checkout: untracked, ignored files do not come with it [MEASURED]

A second difference between a worktree and the main checkout bit in the same session. The repo's
own publish gate (`bun publish.ts --check`) compares the canonical file set against the *user
scope* (`~/.pi/agent/extensions/…`). Run from a fresh worktree it reported 12 problems, all of the
form "extra file at destination (not canonical)": the user scope contains `.DS_Store` files that
the main checkout has in its canonical tree and the worktree does not, because `.DS_Store` is
untracked and ignored and a worktree checkout does not carry it. Copying the 33 `.DS_Store` files
from the main checkout into the worktree turned the check green ("in sync: canonical source ==
user scope for all owned extensions", exit 0).

So a worktree's `--check` failure can be an artefact of the worktree, not real drift — and the
same check on the real checkout is the authority.

**Evidence:** `bun publish.ts --check` from the worktree (12 items, all `.DS_Store` "extra file at
destination"); the same command from the main checkout ("in sync: canonical source == user scope
for all owned extensions"); and the same command from the worktree after copying the 33
`.DS_Store` files across (also "in sync", exit 0). The main checkout has 33 such files under
`extensions/**`; the worktree had 0.

### F4 — The rule, and the one-line check that would have caught F1 [INFERRED]

The rule that removes the hazard is the one the parallel session adopted independently: in a
checkout shared between sessions, never `git checkout -b`, never `git reset`, never `git commit` —
use `git worktree add <path> <branch>` and work there, pushing only branches you created in it. A
`git reset` in the shared checkout is safe only when no other session's branch is checked out
there, which is exactly the condition a shared checkout cannot guarantee.

A cheap guard, if the repo wants one: after any `git reset` in the shared checkout, compare each
branch's tip against what its reflog says it was (`git reflog show <branch> | head -3`) — the
rewind is visible there immediately, whereas in the working tree it looks like an ordinary
fast-forward.

**Reasoning from:** F1 (the reset moved another branch's ref), F2 (the reflog was the only
recovery route), and the parallel session's own statement that it now "never branch, reset or
commit in the shared checkout — always a dedicated worktree".

## Still open

- Whether the repo should adopt the guard from F4 as an instruction (the agent-instruction files
  here are generated from ai-badger, so the change belongs upstream, not in this repository).
- Whether the `.DS_Store` files in the canonical tree (F3) should be removed from the checkout
  instead — they are untracked and ignored, so they are invisible to git and only ever confuse a
  check run from a worktree.
