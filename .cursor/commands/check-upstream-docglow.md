# Check upstream docglow for upgrades and interesting PRs

Compare this fork (`lassebenni/docglow`) against the parent repo [docglow/docglow](https://github.com/docglow/docglow). Decide whether a version upgrade or cherry-pick from upstream open PRs is worth doing now.

## Context

- **Upstream**: https://github.com/docglow/docglow — OSS docglow maintained by Joshua Moore (`cplax14`)
- **This fork**: ships VanTilburg / `vt-dbt` features ahead of upstream; allowed to diverge
- **Consumer**: `vt-dbt` installs via `pip install -e <path-to-fork>`
- **Porting tracker**: `PORTING_TODO.md` — deferred work is intentional, not a gap
- **Review context**: `.github/copilot-instructions.md` — fork-specific assumptions

Do **not** merge upstream PRs or push branches unless the user explicitly asks. This command is analysis and recommendations only.

## Step 1 — Gather facts

Run the helper script (needs `gh` and network):

```bash
./scripts/check_upstream_docglow.sh
```

If the script fails, gather the same data manually:

1. Fork version: `src/docglow/__init__.py` → `__version__`
2. Upstream latest release: `gh api repos/docglow/docglow/releases/latest`
3. Divergence: `git fetch https://github.com/docglow/docglow.git main:refs/remotes/upstream-docglow/main` then compare `main` vs `upstream-docglow/main`
4. Open upstream PRs: `gh pr list -R docglow/docglow --state open`
5. Release notes between fork version tag and latest upstream tag

Read `PORTING_TODO.md` and skim recent fork-only features on `main` (Questions tab, Data tab, PII handling, lineage patches, etc.) so you know what we already have that upstream may not.

## Step 2 — Version upgrade assessment

For each upstream release **after** the fork's `__version__`, summarize:

| Area | What changed | Worth upgrading? | Notes |
|------|--------------|------------------|-------|
| … | … | yes / maybe / skip | conflict risk, vt-dbt value |

**Upgrade-worth signals** (prioritize these):

- Bug fixes in code paths the fork still shares (artifact parsing, health scoring, cloud publish, profiler, column lineage core)
- Security or data-loss fixes
- Features the fork does **not** already implement in a different form
- Cloud / `docglow publish` fixes if we publish to Docglow Cloud

**Usually skip or defer**:

- UI-only changes that would conflict with fork lineage / Data tab / Questions tab work
- Features we already shipped differently (check fork `CHANGELOG.md` and `main` log)
- Large landing-page / overview redesigns unless we want parity with demo.docglow.com

Rate overall upgrade urgency: **none** | **low** | **medium** | **high** — with one sentence why.

If worth upgrading, outline a **merge strategy** (not execute it):

- `git merge upstream-docglow/main` vs cherry-pick specific commits
- Files likely to conflict (`frontend/src/pages/ModelPage.tsx`, `frontend/src/utils/graph.ts`, `generator/pipeline.py`, static bundle)
- Whether `npm run build:sync` + full test pass is required

## Step 3 — Open upstream PR review

For each open PR at https://github.com/docglow/docglow/pulls:

1. Fetch details: `gh pr view <number> -R docglow/docglow --json title,body,additions,deletions,changedFiles,files,commits`
2. Skim touched paths for overlap with fork-only code
3. Classify:

| PR | Summary | Integrate? | Rationale |
|----|---------|------------|-----------|
| #… | … | yes / maybe / no | … |

**Integrate-worth signals**:

- Fixes a bug we likely share (health scoring, null artifact fields, cloud upload limits)
- Small, isolated change in Python generator / analyzer with no frontend conflict
- Community PR solving a problem we've seen in `vt-dbt`

**Usually skip**:

- PRs that rewrite the same UI areas we've heavily forked (model page, lineage toolbar, overview)
- PRs still in heavy flux or lacking CI green
- Duplicates of work already on fork `main`

For **yes** or **maybe** PRs, note: cherry-pick vs wait for release, and whether to upstream our fork changes first to reduce conflict.

## Step 4 — Output format

Reply with this structure:

### Summary
2–4 sentences: version gap, overall upgrade urgency, top 1–3 actionable items.

### Version gap
- Fork: `X.Y.Z` on branch `…`
- Upstream latest: `v…` (date)
- Commits upstream ahead / fork ahead

### Release highlights worth taking
Bullet list with links to upstream PRs/releases.

### Open upstream PRs worth watching
Bullet list with PR links and integrate recommendation.

### Skip / already covered
Brief list of upstream changes that are redundant or low value for this fork.

### Suggested next step
One concrete action (e.g. "cherry-pick #132 null artifact fix", "merge upstream main and resolve ModelPage conflicts", or "no action — fork is ahead on features that matter").

Keep the report concise; use tables only where they add clarity. Link GitHub URLs in markdown.
