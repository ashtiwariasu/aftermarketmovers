#!/usr/bin/env bash
set -euo pipefail

git fetch origin --prune --quiet

if ! git merge-base --is-ancestor origin/main HEAD; then
  behind="$(git rev-list --count HEAD..origin/main)"
  echo "release blocked: this branch does not contain current origin/main (${behind} main commit(s) missing)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "release blocked: the worktree is not clean" >&2
  git status --short >&2
  exit 1
fi

echo "release base verified: $(git rev-parse --short origin/main) is contained in $(git rev-parse --short HEAD)"
