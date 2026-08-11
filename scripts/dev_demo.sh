#!/usr/bin/env bash
# Build the SPA, generate a jaffle-shop demo site with sample Data-tab fixtures,
# and serve it locally. Intended for interactive frontend feature testing.
#
# Usage (from repo root):
#   ./scripts/dev_demo.sh
#   npm run demo --prefix frontend
#
# Env:
#   DOCGLOW_DEMO_PORT   serve port (default: 8081)
#   DOCGLOW_DEMO_OUT    output dir (default: ./demo-site)
#   SKIP_BUILD=1        skip frontend build:sync (reuse existing static bundle)
#   DOCGLOW_BIN         path to docglow CLI (default: .venv/bin/docglow or docglow)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${DOCGLOW_DEMO_PORT:-8081}"
OUT="${DOCGLOW_DEMO_OUT:-$ROOT/demo-site}"
SAMPLE="$ROOT/examples/jaffle-shop/sample-data"
PROJECT="$ROOT/examples/jaffle-shop"

if [[ -n "${DOCGLOW_BIN:-}" ]]; then
  DOCGLOW="$DOCGLOW_BIN"
elif [[ -x "$ROOT/.venv/bin/docglow" ]]; then
  DOCGLOW="$ROOT/.venv/bin/docglow"
elif command -v docglow >/dev/null 2>&1; then
  DOCGLOW="$(command -v docglow)"
else
  echo "error: docglow CLI not found. Install with: pip install -e '.[dev]'" >&2
  exit 1
fi

if [[ ! -d "$SAMPLE" ]]; then
  echo "error: sample-data fixtures missing at $SAMPLE" >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
    echo "→ npm ci (frontend)"
    (cd "$ROOT/frontend" && npm ci)
  fi
  echo "→ npm run build:sync"
  (cd "$ROOT/frontend" && npm run build:sync)
else
  echo "→ SKIP_BUILD=1 — reusing src/docglow/static/"
fi

echo "→ docglow generate (jaffle-shop + sample-data)"
"$DOCGLOW" generate \
  --project-dir "$PROJECT" \
  --output-dir "$OUT" \
  --static \
  --sample-data-dir "$SAMPLE" \
  --exposure-field-lineage "$PROJECT/exposure_field_lineage.json" \
  --skip-column-lineage

cat <<EOF

Demo ready.
  Site:      http://127.0.0.1:${PORT}/
  Data tab:  http://127.0.0.1:${PORT}/#/model/model.jaffle_shop.orders/data
  Customers: http://127.0.0.1:${PORT}/#/model/model.jaffle_shop.customers/data

EOF

exec "$DOCGLOW" serve --dir "$OUT" --port "$PORT" --host 127.0.0.1
