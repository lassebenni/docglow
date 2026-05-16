"""Transform dbt manifest sources into Docglow source dicts."""

from __future__ import annotations

from typing import Any

from docglow.artifacts.catalog import Catalog
from docglow.artifacts.manifest import ManifestNode, ManifestSource
from docglow.artifacts.run_results import RunResult
from docglow.generator.transforms.lookups import build_column_tests


def transform_source(
    source: ManifestSource,
    catalog: Catalog,
    source_freshness: Any | None,
    test_nodes_by_id: dict[str, list[ManifestNode]] | None = None,
    run_results_by_id: dict[str, RunResult] | None = None,
) -> dict[str, Any]:
    """Transform a manifest source into a DocglowSource dict.

    Columns are merged from two sources:
    - The dbt catalog (populated by ``dbt docs generate``) wins on data_type
      and column ordering when present.
    - ``sources.yml`` declarations in the manifest fill in any columns the
      catalog doesn't have. This is what makes column-level lineage terminate
      at sources for users who don't run ``dbt docs generate``.
    """
    test_nodes_by_id = test_nodes_by_id or {}
    run_results_by_id = run_results_by_id or {}

    catalog_node = catalog.sources.get(source.unique_id)

    catalog_columns: dict[str, Any] = {}
    if catalog_node and catalog_node.columns:
        catalog_columns = catalog_node.columns

    column_tests = build_column_tests(source.unique_id, test_nodes_by_id, run_results_by_id)

    columns: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Catalog columns first (preserve warehouse ordering via index).
    sorted_catalog = sorted(catalog_columns.values(), key=lambda c: c.index)
    for col in sorted_catalog:
        lower_name = col.name.lower()
        if lower_name in seen:
            continue
        manifest_col = source.columns.get(col.name) or source.columns.get(lower_name)
        columns.append(
            {
                "name": col.name,
                "description": manifest_col.description if manifest_col else "",
                "data_type": col.type if hasattr(col, "type") else "",
                "meta": dict(manifest_col.meta) if manifest_col else {},
                "tags": list(manifest_col.tags) if manifest_col else [],
                "tests": column_tests.get(lower_name, []),
                "profile": None,
            }
        )
        seen.add(lower_name)

    # Then any sources.yml-declared columns the catalog didn't cover.
    for col_name, manifest_col in source.columns.items():
        lower_name = col_name.lower()
        if lower_name in seen:
            continue
        columns.append(
            {
                "name": col_name,
                "description": manifest_col.description,
                "data_type": manifest_col.data_type or "",
                "meta": dict(manifest_col.meta),
                "tags": list(manifest_col.tags),
                "tests": column_tests.get(lower_name, []),
                "profile": None,
            }
        )
        seen.add(lower_name)

    # Freshness info
    freshness_status = None
    freshness_max_loaded_at = None
    freshness_snapshotted_at = None

    if source_freshness:
        for fr in source_freshness.results:
            if fr.unique_id == source.unique_id:
                freshness_status = fr.status
                freshness_max_loaded_at = fr.max_loaded_at
                freshness_snapshotted_at = fr.snapshotted_at
                break

    return {
        "unique_id": source.unique_id,
        "name": source.name,
        "source_name": source.source_name,
        "description": source.description or source.source_description,
        "schema": source.schema_ or "",
        "database": source.database or "",
        "columns": columns,
        "tags": list(source.tags),
        "meta": dict(source.meta),
        "loader": source.loader,
        "loaded_at_field": source.loaded_at_field,
        "freshness_status": freshness_status,
        "freshness_max_loaded_at": freshness_max_loaded_at,
        "freshness_snapshotted_at": freshness_snapshotted_at,
    }
