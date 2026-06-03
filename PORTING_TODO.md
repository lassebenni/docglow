# Pending TSX ports

These patches live in `vt-dbt-feat+thunderstock-sku-export/scripts/dev/patch_docglow.py`
and target the **minified JS bundle** in the upstream wheel. Now that the
fork owns the TSX source, each one needs re-expressing as a proper React
edit. Until they ship, the fork's lineage UI matches upstream docglow,
not the vt-dbt-customised behaviour.

Grouped by the React file they likely touch (verify before editing — minified
identifier names are not stable).

## Lineage graph filtering (`frontend/src/utils/graph.ts` + `lineageFilters.ts`)
- [ ] `patch_lineage_focal_paths` — restrict BFS to only direct upstream/downstream paths (drops sideways/bypassing edges). Touches the `vO`/`pO`/`gO` functions in the bundle, which correspond to `getSubgraph` and its BFS helpers.
- [ ] `patch_lineage_parent_siblings_inject` — when "Parent outputs" is checked, inject sibling nodes into the focal subgraph.
- [ ] `patch_lineage_exclude_cascade` — exclude a node + all its downstream descendants.
- [ ] `patch_lineage_exclude_protect_focal` — never cascade-exclude the focal node itself.
- [ ] `patch_lineage_parent_children_brace_fix` — JS brace-closure fix introduced by the cascade patch.

## ModelPage lineage UI (`frontend/src/pages/ModelPage.tsx`)
- [ ] `patch_frontend_model_page` — move the model markdown description out of the page header into a "Documentation" tab. (NB: ModelPage.tsx already has a Documentation tab; verify if this patch is still needed against upstream main.)
- [ ] `patch_lineage_dag_toggle` — Layered vs. direct-DAG layout toggle.
- [ ] `patch_lineage_model_page_layers_filter` — layer filter dropdown.
- [ ] `patch_lineage_parents_depth_slider` + `patch_lineage_children_depth_slider` — split the single depth slider into parents/children sliders.
- [ ] `patch_lineage_model_page_exclude_filter` — exclude-by-name filter.

## Notes
- The bundle filename hash in `src/docglow/static/assets/index-*.js` changes on every `npm run build:sync`, so the existing `.replace(<minified-snippet>, ...)` calls in `patch_docglow.py` cannot be re-run against the fork.
- Recommended workflow for each port: locate the corresponding upstream TSX (the minified snippet is a hint), make the edit in source, `cd frontend && npm run build:sync`, regenerate `target/docglow`, verify in browser.
