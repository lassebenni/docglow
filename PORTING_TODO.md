# Patches ported from vt-dbt → fork

Originally `vt-dbt/scripts/dev/patch_docglow.py` rewrote the **minified JS bundle**
in place after every `pip install --upgrade docglow`. Now that the fork owns
the TSX source, each patch has been re-expressed as a proper React/TS edit.

## Ported

### Python (`src/docglow/...`)
- `patch_pipeline` — analyses as models (`generator/pipeline.py`).
- `patch_docglow_manifest_child_map` — embed `manifest_child_map` in the JSON (`generator/pipeline.py`).
- `patch_unit_tests_in_test_map` — merge `manifest.unit_tests` into `build_test_map` (`generator/transforms/lookups.py`).
- `patch_unit_tests_test_type` — label `test_type='unit_test'` (`generator/transforms/models.py`).
- `patch_models_transform` — fall back `compiled_sql` to `raw_code` for analyses (`generator/transforms/models.py`).
- `patch_profiler_resilience` + `patch_docglow_profiler.py` — PG `::DOUBLE PRECISION`, LIMIT subquery, rollback on failure, skip missing columns (`profiler/queries.py` + `profiler/engine.py`).
- `patch_filters_closure_file` — `@file` selection (`generator/filters.py`).
- `patch_filters_focal_downstream` — collect upstream/downstream from seed match only (`generator/filters.py`).
- `patch_lineage_builder` — tag analyses with `resource_type='analysis'` in the lineage graph (`generator/lineage_builder.py`).

### Frontend (`frontend/src/...`)
- `patch_frontend_model_page` — Documentation tab on ModelPage (model description moved out of the header) with "No model description." fallback (`pages/ModelPage.tsx`).
- `patch_lineage_focal_paths` — `getSubgraph` rewritten with per-direction BFS distance maps; only monotonic edges (`uD[src] === uD[tgt]+1`, `dD[tgt] === dD[src]+1`) are kept, dropping sideways and bypass edges (`utils/graph.ts`).
- `patch_lineage_parents_depth_slider` + `patch_lineage_children_depth_slider` — independent Parents and Children depth sliders on ModelPage; master Depth still resets both (`utils/graph.ts` extra params + `pages/ModelPage.tsx` state + UI).
- `patch_lineage_dag_toggle` — Layered/DAG layout toggle persisted in `localStorage` (`pages/ModelPage.tsx`).
- `patch_lineage_model_page_layers_filter` — Layers filter dropdown on the ModelPage lineage toolbar (`pages/ModelPage.tsx`).
- `patch_lineage_model_page_exclude_filter` — Models filter dropdown (per-node include/exclude) on the ModelPage lineage toolbar (`pages/ModelPage.tsx`).
- `patch_lineage_exclude_cascade` — excluding a node drops the node AND all downstream descendants via `getDescendants()` (`utils/graph.ts` + `pages/ModelPage.tsx`).
- `patch_lineage_exclude_protect_focal` — the focal model is never excluded by the Models filter (`pages/ModelPage.tsx`).

## Deferred

These are valuable but require a new UI surface and additional state machine
that wasn't shipped with this PR. They are no-ops for current behavior.

- `patch_lineage_parent_siblings_inject` — a "Parent outputs" checkbox that,
  when enabled, injects sibling nodes (other children of the focal's parents)
  into the focal subgraph. Wants: a toolbar checkbox + an opt-in branch in
  `getSubgraph`.
- `patch_lineage_parent_children_brace_fix` — was a JS-bundle fix for a
  brace-closure regression introduced by the cascade patch; not needed in
  TSX source.
- The Lineage Explorer (`/lineage`) variants of the cascade/protect/Models
  patches — analogous to the ModelPage ports above, but applied to
  `pages/LineagePage.tsx`. Same pattern, separate PR.
