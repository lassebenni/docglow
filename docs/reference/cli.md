# CLI Reference

## Commands

### `docglow generate`

Generate the documentation site from dbt artifacts.

```bash
docglow generate [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project-dir` | `.` | Path to the dbt project root |
| `--target-dir` | `target/` | Path to the dbt target directory |
| `--output-dir` | `target/docglow/` | Where to write the generated site |
| `--static` | off | Bundle everything into a single `index.html` |
| `--theme` | `auto` | Theme: `auto`, `light`, or `dark` |
| `--title` | project name | Custom site title |
| `--select` | all | Only include models matching this pattern |
| `--exclude` | none | Exclude models matching this pattern |
| `--slim` | off | Omit raw/compiled SQL from output (reduces file size 40-60%) |
| `--ai` | off | Enable AI chat panel |
| `--ai-key` | env var | Anthropic API key (or set `ANTHROPIC_API_KEY`) |
| `--skip-column-lineage` | off | Skip column-level lineage analysis |
| `--column-lineage-select` | all | Only analyze column lineage for this model |
| `--column-lineage-depth` | unlimited | Max hops from the selected model |
| `--exposure-field-lineage` | none | Path to `exposure_field_lineage.json` sidecar mapping exposure fields (e.g. Power BI measures) to mart columns; merged into column lineage at generate time |
| `--powerbi-model` | none | Path to a Power BI TMDL semantic model folder (PBIP). Reads measures and their column lineage straight from the DAX — no sidecar to maintain. Needs `--powerbi-exposure` and `pip install 'docglow[powerbi]'` |
| `--powerbi-exposure` | none | Name of the dbt exposure that `--powerbi-model`'s measures belong to |
| `--include-packages` | off | Include dbt package models in lineage |
| `--profile` | off | Enable column profiling |
| `--profile-adapter` | none | Database adapter (`duckdb`, `postgres`, `snowflake`) |
| `--profile-connection` | none | Connection string or DB path |
| `--profile-sample-size` | 10000 | Max rows to sample per model |
| `--profile-no-cache` | off | Skip profile caching |
| `--fail-under` | none | Exit code 1 if health score below threshold (0-100) |
| `--enable-erd` | off | Render the [ERD view](../erd.md) at `/erd` from your `relationships` tests, `dbt_constraints`, and `meta.docglow.relationships` blocks |
| `--term-aliases` | none | Path to `bc_term_aliases.yaml` for Dutch/English business term search enrichment |
| `--verbose` | off | Enable debug logging |

### `docglow serve`

Serve the generated site locally.

```bash
docglow serve [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--dir` | `target/docglow/` | Directory to serve |
| `--port` | `8081` | Port number |
| `--host` | `127.0.0.1` | Host address |
| `--open/--no-open` | open | Auto-open browser |
| `--watch` | off | Watch for artifact changes and auto-rebuild |
| `--project-dir` | `.` | dbt project root (for `--watch` mode) |

### `docglow health`

Show project health score and coverage metrics.

```bash
docglow health [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project-dir` | `.` | Path to the dbt project root |
| `--target-dir` | `target/` | Path to the dbt target directory |
| `--format` | `table` | Output format: `table`, `json`, or `markdown` |
| `--select` | all | Only include matching models |
| `--fail-under` | none | Exit code 1 if score below threshold |

### `docglow mcp-server`

Start an MCP server for AI editor integration.

```bash
docglow mcp-server [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project-dir` | `.` | Path to the dbt project root |
| `--target-dir` | `target/` | Path to the dbt target directory |

### `docglow init`

Generate a starter `docglow.yml` configuration file.

```bash
docglow init [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project-dir` | `.` | Where to create `docglow.yml` |
| `--force` | off | Overwrite existing `docglow.yml` |

### `docglow profile`

Run column-level profiling only (without generating a site).

```bash
docglow profile [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project-dir` | `.` | Path to the dbt project root |
| `--target-dir` | `target/` | Path to the dbt target directory |
| `--adapter` | required | Database adapter (`duckdb`, `postgres`, `snowflake`) |
| `--connection` | required | Connection string or path |
| `--sample-size` | 10000 | Max rows to sample per model |
| `--no-cache` | off | Skip profile caching |
| `--output` | `target/docglow/` | Output directory for `profiles.json` |
| `--verbose` | off | Enable debug logging |

### `docglow publish`

Publish documentation to Docglow Cloud.

```bash
docglow publish [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--token` | `DOCGLOW_TOKEN` env var | API token |
| `--project-dir` | `.` | Path to the dbt project root |
| `--target-dir` | `target/` | Path to the dbt target directory |
| `--api-url` | `https://app.docglow.com` | Override the API base URL. Falls back to `DOCGLOW_API_URL` env var, then `~/.docglow/config.json`. |
| `--no-wait` | off | Don't wait for processing to complete |
| `--verbose` | off | Enable debug logging |

To target a non-production environment (e.g. staging):

```bash
docglow publish --api-url https://app-staging.docglow.com
# or
DOCGLOW_API_URL=https://app-staging.docglow.com docglow publish
```

### `docglow login`

Authenticate with Docglow Cloud. Get your API token at [https://app.docglow.com/settings/tokens](https://app.docglow.com/settings/tokens).

```bash
docglow login [--token YOUR_TOKEN]
```

### `docglow logout`

Remove stored Docglow Cloud credentials.

```bash
docglow logout
```


## Power BI measure lineage

A Power BI dashboard is usually the last hop of a dbt lineage graph, and the hop
Docglow cannot infer from SQL: the logic lives in DAX inside the model. Two ways
to supply it, both landing in the same place — the exposure's measures become
columns, and their dependencies merge into column-level lineage.

**From the semantic model** (no sidecar to maintain):

```bash
pip install 'docglow[powerbi]'
docglow generate \
  --powerbi-model path/to/Sales.SemanticModel \
  --powerbi-exposure powerbi_sales_dashboard
```

Docglow reads `definition/tables/*.tmdl`, parses each measure's DAX, and records
the columns it aggregates. A Power BI table is matched to a dbt model **by name**
— which is how imported marts normally appear — so `SUM(fct_orders[amount])`
becomes an edge to `fct_orders.amount`. Tables matching no dbt model are reported
once and skipped.

Columns used only to *filter* are not recorded as lineage: in
`CALCULATE(SUM(fct_orders[amount]), fct_orders[is_service] = TRUE)` the measure
reads `amount` and filters on `is_service`. Dimension tables (`dim_*`) and
disconnected helper tables (`_*`) are always filter context.

What DAX cannot express stays out: `COUNTROWS(agg_orders)` names no column, so a
measure counting rows records no lineage. Use the sidecar for those.

**From a sidecar** — `--exposure-field-lineage`, for hand-curated mappings or a
model Docglow cannot read. The schema is documented in
`docglow.lineage.exposure_field_lineage`.

The DAX parser needs Python 3.11+ (Docglow itself supports 3.10). Without the
extra, `--powerbi-model` warns and is skipped rather than failing the build.
