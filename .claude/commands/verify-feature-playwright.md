# Verify feature with Playwright (local browser)

Run a **local, browser-level check** of a Docglow UI change using Playwright — the same stack as the repo's e2e suite (also runs on PRs via CI), scoped to the feature you just built.

## Input

`$ARGUMENTS` — optional:

| Argument | Meaning |
| :--- | :--- |
| *(empty)* | Run the spec that best matches recent frontend changes, or ask which route to hit |
| `e2e/<spec>.spec.ts` | Run one Playwright file (path relative to `frontend/`) |
| `e2e/<spec>.spec.ts -g "test name"` | Run one test by title grep |
| `http://127.0.0.1:<port>/#/...` | Manual route hint when writing or debugging a new spec |

## When to use

- After changing `frontend/src/**` (especially lineage, model pages, Data tab, search).
- When the user asks to “verify with playwright”, “browser test”, or “check it works locally”.
- **Not** a substitute for `tsc`, vitest, or `/evaluate-pr-docglow` — this is **behaviour in a real browser**.

## Steps

### 1. Sync the bundle if you changed frontend source

Docglow ships a pre-built SPA under `src/docglow/static/`. For fork verification against `docglow serve` / demo scripts, run:

```bash
cd frontend && npm run build:sync
```

Playwright in this repo uses **Vite preview** (`frontend/dist/`), not the Python static tree. `playwright.config.ts` copies `e2e/fixtures/docglow-data.json` into `public/` and runs `npm run build` before starting preview — you normally only need `npx playwright test` (see step 3).

### 2. Install browsers once per machine (if missing)

From `frontend/`:

```bash
npx playwright install chromium
```

If the sandbox blocks browser binaries, retry with full permissions.

### 3. Build and run Playwright

From `frontend/`:

```bash
npx playwright test <spec-or-pattern> --reporter=line
```

Examples:

```bash
npx playwright test e2e/lineage-view-details.spec.ts --reporter=line
npx playwright test e2e/seed-data.spec.ts -g "Data tab" --reporter=line
npx playwright test e2e/ --reporter=line   # full e2e suite (slower)
```

`playwright.config.ts` starts `npm run preview` on port **4173** automatically (`reuseExistingServer` locally).

### 4. Prefer fixture routing for deterministic data

Most specs under `frontend/e2e/` mock `**/docglow-data.json` with a committed fixture so tests do not need a live `docglow generate` output. When adding a new feature test:

1. Copy or extend `frontend/e2e/fixtures/docglow-data.json` (or a focused fixture like `docglow-data-exposure-field-lineage.json`).
2. `page.route('**/docglow-data.json', …)` in `beforeEach`.
3. Navigate to the exact hash route: `/#/model/<id>/lineage`, `/#/model/<id>/data`, etc.
4. Add `data-testid` on new interactive elements when role/text selectors are fragile.

### 5. New-tab / popup flows

```typescript
const [newPage] = await Promise.all([
  context.waitForEvent('page'),
  page.getByTestId('…').click(),
])
await expect(newPage).toHaveURL(/expected-hash-route/)
await expect(page).toHaveURL(originalUrl) // current tab unchanged
```

### 6. Optional screenshots (chat review only)

When visual confirmation helps, set `VERIFY_SCREENSHOT=1` if the spec supports it, or add a one-off capture:

```bash
VERIFY_SCREENSHOT=1 npx playwright test e2e/<spec>.spec.ts --reporter=line
```

Save under `assets/verify-<topic>-<state>.png` (gitignored). See `.cursor/rules/screenshot-workflow.mdc`.

### 7. Report

State clearly:

- command(s) run and pass/fail counts
- which route and assertion proved the feature
- screenshot path if taken
- any blocker (missing chromium, stale `dist/`, flaky selector)

## Rules

- **Do** run Playwright yourself — do not only describe the steps.
- **Do** add or extend an e2e spec when verifying a new UI interaction worth regressing.
- **Do not** commit `assets/verify-*.png`, `playwright-report/`, or `test-results/`.
- **Do not** use this command to merge PRs or skip code review.
- Gate optional screenshots behind `VERIFY_SCREENSHOT=1` in committed specs when possible.

## Related

| Task | Command / doc |
| :--- | :--- |
| Screenshot-only verify | `.cursor/rules/screenshot-workflow.mdc` |
| PR critique | `/evaluate-pr-docglow` |
| Interactive demo | `./scripts/dev_demo.sh` |
