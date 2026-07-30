#!/usr/bin/env bash
# Gather facts for comparing this fork (lassebenni/docglow) with upstream (docglow/docglow).
# Used by the /check-upstream-docglow Cursor command. Safe to run manually.
set -euo pipefail

UPSTREAM_REPO="docglow/docglow"
UPSTREAM_URL="https://github.com/${UPSTREAM_REPO}"
FORK_REPO="lassebenni/docglow"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found (install: https://cli.github.com/)" >&2
  exit 1
fi

fork_version=""
if [[ -f src/docglow/__init__.py ]]; then
  fork_version="$(grep -E '^__version__\s*=' src/docglow/__init__.py | sed -E 's/.*"([^"]+)".*/\1/')"
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
merge_base=""
upstream_ahead=0
fork_ahead=0

git fetch "https://github.com/${UPSTREAM_REPO}.git" main:refs/remotes/upstream-docglow/main --quiet 2>/dev/null || true
if git rev-parse upstream-docglow/main >/dev/null 2>&1; then
  merge_base="$(git merge-base main upstream-docglow/main 2>/dev/null || true)"
  if [[ -n "$merge_base" ]]; then
    upstream_ahead="$(git rev-list --count "${merge_base}..upstream-docglow/main" 2>/dev/null || echo 0)"
    fork_ahead="$(git rev-list --count "${merge_base}..main" 2>/dev/null || echo 0)"
  fi
fi

upstream_latest_tag="$(gh api "repos/${UPSTREAM_REPO}/releases/latest" --jq '.tag_name' 2>/dev/null || echo unknown)"
upstream_latest_published="$(gh api "repos/${UPSTREAM_REPO}/releases/latest" --jq '.published_at' 2>/dev/null || echo unknown)"

echo "=== docglow upstream check ==="
echo "fork_repo:        ${FORK_REPO}"
echo "upstream_repo:    ${UPSTREAM_REPO}"
echo "upstream_url:     ${UPSTREAM_URL}"
echo "fork_branch:      ${branch}"
echo "fork_version:     ${fork_version:-unknown}"
echo "upstream_latest:  ${upstream_latest_tag} (published ${upstream_latest_published})"
echo "merge_base:       ${merge_base:-none}"
echo "upstream_ahead:   ${upstream_ahead} commits on main not in fork main"
echo "fork_ahead:       ${fork_ahead} commits on fork main not in upstream main"
echo ""

if [[ -n "$merge_base" ]] && [[ "$upstream_ahead" -gt 0 ]]; then
  echo "--- upstream main commits missing from fork main (top 20) ---"
  git log --oneline "${merge_base}..upstream-docglow/main" -20 2>/dev/null || true
  echo ""
fi

if [[ -n "$merge_base" ]] && [[ "$fork_ahead" -gt 0 ]]; then
  echo "--- fork main commits not in upstream main (top 15) ---"
  git log --oneline "${merge_base}..main" -15 2>/dev/null || true
  echo ""
fi

if [[ -n "$fork_version" ]] && [[ "$upstream_latest_tag" != unknown ]]; then
  compare_tag="${upstream_latest_tag}"
  if [[ "$compare_tag" != v* ]]; then
    compare_tag="v${compare_tag}"
  fi
  fork_tag="v${fork_version}"
  echo "--- release diff ${fork_tag} → ${compare_tag} ---"
  gh api "repos/${UPSTREAM_REPO}/compare/${fork_tag}...${compare_tag}" \
    --jq '{commits:.commits|length,files:.files|length,status}' 2>/dev/null || echo "(compare failed — tag may be missing locally)"
  echo ""
  gh release view "${compare_tag}" -R "${UPSTREAM_REPO}" 2>/dev/null || true
  echo ""
fi

echo "--- open upstream pull requests ---"
gh pr list -R "${UPSTREAM_REPO}" --state open \
  --json number,title,author,createdAt,updatedAt,additions,deletions,changedFiles,labels \
  --limit 20 2>/dev/null | python3 -c "
import json, sys
prs = json.load(sys.stdin)
for p in prs:
    author = p.get('author', {}).get('login', '?')
    print(f\"#{p['number']} {p['title']} (@{author}, +{p.get('additions',0)}/-{p.get('deletions',0)}, {p.get('changedFiles',0)} files, updated {p.get('updatedAt','')[:10]})\")
" 2>/dev/null || gh pr list -R "${UPSTREAM_REPO}" --state open --limit 20

echo ""
echo "--- upstream issues (open, label enhancement or bug, top 10) ---"
gh issue list -R "${UPSTREAM_REPO}" --state open --label enhancement --limit 5 2>/dev/null || true
gh issue list -R "${UPSTREAM_REPO}" --state open --label bug --limit 5 2>/dev/null || true

echo ""
echo "pulls: ${UPSTREAM_URL}/pulls"
echo "releases: ${UPSTREAM_URL}/releases"
echo "compare: ${UPSTREAM_URL}/compare/${fork_tag:-main}...${compare_tag:-main}"
