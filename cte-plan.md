# CTE SQL graph (v1–v3)

Intra-model SQL / CTE lineage for Docglow. Complements dbt DAG **Table** / **Columns** modes by showing what happens *inside* a focus model's compiled SQL.

## Problem

Columns mode shows dbt parents and resolved join endpoints. Intermediate CTEs (e.g. `order_supplies_summary`) are invisible, so parents like `stg_supplies` can look unjoined even when they feed the model via aggregate CTEs.

CTEs mode renders the **query AST graph** for the focus model only.

## UI

- **Model Lineage tab only** (global `/lineage` out of v1).
- Keep `Table | Columns` as dbt-DAG disclosure.
- Add sibling control **CTEs** that **swaps the canvas** to an intra-model SQL graph (not a denser version of the same DAG).

## Roadmap

### v1 — Model SQL graph (done)

Nodes:

| Kind | Meaning |
|------|---------|
| `parent` | Resolved dbt unique_id (`stg_*`, sources, …) |
| `cte` | Named `WITH` clause |
| `join` | Explicit join step (type + key columns) |
| `output` | Final model result |

Edges: data flow between those nodes. Aggregate-only CTEs get `transforms: ["aggregate"]`.

Passthrough CTEs (`select * from ref`) still appear as CTE nodes, linked from their underlying parent.

No per-column click path in v1. CTE/parent nodes may list output column names when cheap.

### v2 — Field drill-down (done)

Click a column on a parent/cte/output node → highlight path + side panel
(`passthrough` / `rename` / `aggregated` / `derived` / `constant`) through CTE steps,
with defining SQL `expression` and ambient transform glyphs.

### v3 — Expand CTE internals (done)

On-demand WHERE / CASE / WINDOW (+ group / derived / cast / coalesce) op nodes.

- Backend: `SqlGraphNode.ops[]` + `passthrough` flag on pure `SELECT *` CTEs
- Frontend: ▶ expand → op nodes; click op → expression panel
- Field path click auto-expands defining CTE ops
- Default-collapse passthrough CTEs (toggle: Show passthrough CTEs)
- Click join node → highlight join-key columns on neighbors


## v1 wire contract

Top-level payload map (alongside `join_keys` / `join_bases`):

```ts
sql_graphs?: Record<string, SqlGraph>  // keyed by model unique_id

interface SqlGraph {
  nodes: SqlGraphNode[]
  edges: SqlGraphEdge[]
  /** v2: intra-graph column deps for field drill-down */
  column_lineage?: Record<string, Record<string, SqlGraphColumnDep[]>>
}

interface SqlGraphColumnDep {
  source_node: string
  source_column: string
  transformation: "passthrough" | "rename" | "aggregated" | "derived"
}

type SqlGraphNodeKind = "parent" | "cte" | "join" | "output"

interface SqlGraphNode {
  id: string
  kind: SqlGraphNodeKind
  label: string
  /** dbt unique_id when kind=parent or kind=output */
  model_id?: string
  /** CTE alias when kind=cte */
  cte_name?: string
  join_type?: string
  join_keys?: { left_column: string; right_column: string }[]
  transforms?: ("aggregate" | "filter" | "window" | "other")[]
  columns?: string[]
}

interface SqlGraphEdge {
  source: string
  target: string
  columns?: string[]
  label?: string
}
```

## Example (`order_items`)

```
stg_order_items → order_items (cte)
stg_orders      → orders (cte)
stg_products    → products (cte)
stg_supplies    → supplies (cte) → order_supplies_summary (cte, aggregate)
order_items + orders  --join order_id→ joined
order_items + products --join product_id→ …
order_items + order_supplies_summary --join product_id→ …
joined → order_items (output)
```

## Implementation notes

- Extractor: `src/docglow/lineage/sql_graph.py` (SQLGlot), reuse CTE passthrough helpers from `join_keys.py`.
- Analyzer caches `sql_graph` per model; bump lineage cache format when the shape changes.
- Frontend: `CteFlow` React Flow canvas on ModelPage when mode=`ctes`.
