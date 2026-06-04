# Copilot review instructions — `lassebenni/docglow`

This fork ships features ahead of upstream `docglow/docglow`. PRs typically port
patches that previously lived in a downstream consumer's
`scripts/dev/patch_docglow.py` (a script that string-replaced the minified
production bundle) into proper TSX/Python source edits — so PR scope is often
"translate a runtime patch into source-of-truth code", not "design a new
feature from scratch".

Use the rules below when reviewing PRs.

## Context Copilot should assume

- **Fork, not upstream PR.** Do not block on "this could be upstreamed" or
  "this changes the upstream contract". The fork is allowed to diverge.
- **Consumer is a dbt project (`vt-dbt`)** that uses the fork via
  `pip install -e <path-to-fork>`. Cross-references like "vt-dbt's
  `scripts/docglow_data/dump_sample.py` writes the JSON" are real and
  intentional.
- **The `feat/data-tab` branch composes 10 small commits.** Each commit
  ports one named patch from the consumer's runtime patcher. Review each
  patch in isolation; don't request a single squashed commit.
- **PORTING_TODO.md** is the source of truth for what's deferred. If a
  feature listed there is "missing", that's intentional — flag only if
  the PR claims to ship it but doesn't.

## What is in-scope for review feedback

- **Real bugs** (logic errors, runtime exceptions, type mismatches,
  data corruption, security holes).
- **Verifiable contract drift** — e.g., a function signature changes
  but a caller wasn't updated. Cite the caller file:line.
- **Security**: path traversal, SSRF, secret leakage, unbounded
  resource use. Be specific about the attack vector.
- **TypeScript / Python type-safety regressions** that the compiler
  doesn't catch (e.g., `as any`, `# type: ignore` introduced
  without justification).
- **Performance hot-paths**: only flag when the change is in a path
  that runs per-model (`generator/pipeline.py` stages, BFS in
  `frontend/src/utils/graph.ts`). Constant-time changes elsewhere
  are not interesting.
- **Test coverage gaps** for the specific behaviour the PR adds —
  not "this whole module is undertested".

## What is out-of-scope (do not raise)

- **Style nits** the project's `ruff` / `eslint` already covers.
- **"Could be DRYer" / extract-helper requests** when the duplication
  is < 3 sites and < 10 lines per site. Three similar lines is fine.
- **Comment density.** This project intentionally keeps comments
  sparse — only when the *why* is non-obvious. Don't request
  comments on self-explanatory code.
- **Docstring formatting** beyond what `ruff` enforces. Don't suggest
  Sphinx vs Google vs NumPy style.
- **Renaming** identifiers for "clarity" when the existing name
  matches the surrounding code or upstream docglow naming.
- **"Add a type alias" / "extract an interface"** unless the same
  shape appears in three+ places.
- **Backwards-compatibility shims** for changes inside the fork.
  This isn't a published library; the only consumer is vt-dbt
  and it ships in lockstep with the fork.
- **"Could be parallelized"** suggestions on code that runs once
  at build time per site (< 5s wall time).

## Patterns the reviewer should recognise

### Fail-soft is intentional

Many scripts in `src/docglow/generator/` log a warning and continue rather
than raise. This is by design — a malformed sample-data file or a missing
ADLS blob must not break the docs publish. Don't request "raise an error
instead". The existing pattern is:

```python
try:
    payload = json.loads(raw)
except json.JSONDecodeError as e:
    logger.warning("%s: not valid JSON (%s) — skipping", path, e)
    continue
```

### PII handling lives in the *producer* (vt-dbt), not docglow

The fork renders whatever JSON it's given. Don't request docglow to "scan
for PII before rendering" — the producer's
`scripts/docglow_data/dump_sample.py` already drops `meta.pii: true`
columns at SQL level *and* applies a name-based safety net. The fork's
responsibility is surfacing `sample_data.excluded_columns` so reviewers
can audit what was withheld; that's already shipped.

### Frontend `<mark>` highlight is intentionally simple

`SampleDataTable.tsx` walks each cell string with `String.indexOf` to
inject `<mark>` spans. Don't request a regex-based highlighter, a
trie, or a virtualised list — for 25 rows × 32 cols × short cells the
straightforward loop is the right shape.

### Static-bundle assets in `src/docglow/static/assets/`

These are *generated* by `npm run build:sync`. Don't review the
content-hashed JS/CSS files — review the source under `frontend/src/`
and `packages/shared-types/`.

## When in doubt

- Prefer fewer, higher-signal comments over many small ones.
- Quote the exact file:line you're commenting on.
- If verifying a claim empirically (regex behaviour, Python exit-code
  semantics, type coercion), say what you tried — the PR author will
  reproduce it and either agree or push back with evidence.
