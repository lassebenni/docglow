"""Transform dbt artifacts into the unified DocglowData JSON payload."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from docglow.artifacts.loader import LoadedArtifacts
from docglow.config import UiConfig
from docglow.generator.layers import LineageLayerConfig


# DOC-214: Wire-shape TypedDicts for the ERD relationship contract.
# These mirror the dict shape produced by `docglow.generator.erd._compose`
# verbatim — TypedDict (not frozen dataclass) is a deliberate choice so DOC-213's
# tested `_compose` output flows straight into the JSON payload without an
# extra construction step. See the DOC-214 plan, "Key Technical Decisions".
class ErdRelationship(TypedDict):
    """One ERD relationship row in `docglow-data.json` (top-level `relationships`).

    Field set is the union of everything `_compose` emits: 17 fields. Optional
    string fields (`label`, `test_unique_id`, `meta_file_path`) are `str | None`.
    Ghost edges (meta-declared edges with no resolvable parent) carry an empty
    string in `to_unique_id`; consumers should treat empty `to_unique_id` as
    "unresolved partner".
    """

    id: str
    from_unique_id: str
    from_column: str
    to_unique_id: str
    to_column: str
    to_model_name: str
    kind: Literal["one_to_one", "one_to_many", "many_to_many", "inferred"]
    child_endpoint: Literal["one_and_only_one", "zero_or_one", "one_or_many", "zero_or_many"]
    parent_endpoint: Literal["one_and_only_one", "zero_or_one", "one_or_many", "zero_or_many"]
    inference_source: Literal["test", "meta", "both"]
    severity: Literal["error", "warn", "info"]
    status: Literal["pass", "fail", "warn", "not_run", "none"]
    label: str | None
    test_unique_id: str | None
    meta_file_path: str | None
    is_synthetic: bool
    parent_column_exists: bool


class RelationshipSummary(TypedDict):
    """Per-model summary entry: top-N partners by edge count.

    Populated by DOC-214 U2 onto each model dict; exposed here so the wire
    contract is type-checked end-to-end.
    """

    partner_unique_id: str
    edge_count: int


@dataclass(frozen=True)
class DocglowColumnTest:
    test_name: str
    test_type: str
    status: str  # pass | fail | warn | error | not_run
    config: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DocglowColumn:
    name: str
    description: str
    data_type: str
    meta: dict[str, Any]
    tags: list[str]
    tests: list[DocglowColumnTest]
    profile: None = None  # Populated in Phase 2


@dataclass(frozen=True)
class DocglowTestResult:
    test_name: str
    test_unique_id: str
    test_type: str
    column_name: str | None
    status: str
    execution_time: float
    failures: int
    message: str | None
    compiled_sql: str | None = None
    raw_sql: str | None = None


@dataclass(frozen=True)
class DocglowLastRun:
    status: str | None
    execution_time: float | None
    completed_at: str | None


@dataclass(frozen=True)
class DocglowCatalogStats:
    row_count: int | None
    bytes: int | None
    has_stats: bool


@dataclass(frozen=True)
class DocglowModel:
    unique_id: str
    name: str
    description: str
    schema: str
    database: str
    materialization: str
    tags: list[str]
    meta: dict[str, Any]
    path: str
    folder: str
    raw_sql: str
    compiled_sql: str
    columns: list[DocglowColumn]
    depends_on: list[str]
    referenced_by: list[str]
    sources_used: list[str]
    test_results: list[DocglowTestResult]
    last_run: DocglowLastRun | None
    catalog_stats: DocglowCatalogStats


@dataclass(frozen=True)
class DocglowSource:
    unique_id: str
    name: str
    source_name: str
    description: str
    schema: str
    database: str
    columns: list[DocglowColumn]
    tags: list[str]
    meta: dict[str, Any]
    loader: str
    loaded_at_field: str | None
    freshness_status: str | None
    freshness_max_loaded_at: str | None
    freshness_snapshotted_at: str | None


@dataclass(frozen=True)
class LineageNode:
    id: str
    name: str
    resource_type: str
    materialization: str
    schema: str
    test_status: str  # pass | fail | warn | none
    has_description: bool
    folder: str
    tags: list[str]


@dataclass(frozen=True)
class LineageEdge:
    source: str
    target: str
    join_keys: tuple[dict[str, str], ...] | None = None


@dataclass(frozen=True)
class SearchEntry:
    unique_id: str
    name: str
    resource_type: str
    description: str
    columns: str
    tags: str
    sql_snippet: str


@dataclass(frozen=True)
class DocglowMetadata:
    generated_at: str
    docglow_version: str
    dbt_version: str
    project_name: str
    project_id: str
    target_name: str
    artifact_versions: dict[str, str | None]
    profiling_enabled: bool
    ai_enabled: bool
    hosted: bool = False
    workspace_slug: str | None = None
    project_slug: str | None = None
    api_base_url: str | None = None
    published_at: str | None = None


@dataclass(frozen=True)
class DocglowData:
    metadata: DocglowMetadata
    models: dict[str, dict[str, Any]]
    sources: dict[str, dict[str, Any]]
    seeds: dict[str, dict[str, Any]]
    snapshots: dict[str, dict[str, Any]]
    exposures: dict[str, dict[str, Any]]
    metrics: dict[str, dict[str, Any]]
    lineage: dict[str, Any]
    health: dict[str, Any]
    search_index: list[dict[str, Any]]
    # DOC-214: ERD relationships extracted by stage_extract_relationships. Empty
    # list when --enable-erd is off; the JSON payload omits the key entirely
    # in that case (see context_to_dict).
    relationships: list[ErdRelationship] = field(default_factory=list)


def build_docglow_data(
    artifacts: LoadedArtifacts,
    *,
    profiling_enabled: bool = False,
    ai_enabled: bool = False,
    select: str | None = None,
    exclude: str | None = None,
    layer_config: LineageLayerConfig | None = None,
    ui_config: UiConfig | None = None,
    column_lineage_enabled: bool = False,
    column_lineage_select: str | None = None,
    column_lineage_depth: int | None = None,
    column_lineage_cache_dir: Any | None = None,
    column_lineage_workers: int | None = None,
    exclude_packages: bool = True,
    slim: bool = False,
    enable_erd: bool = False,
) -> dict[str, Any]:
    """Transform loaded artifacts into the unified DocglowData payload.

    Delegates to the generation pipeline, which executes discrete named stages.
    Returns a plain dict suitable for JSON serialization.
    """
    from docglow.generator.pipeline import (
        PipelineContext,
        context_to_dict,
        default_stages,
        run_pipeline,
    )

    ctx = PipelineContext(
        artifacts=artifacts,
        profiling_enabled=profiling_enabled,
        ai_enabled=ai_enabled,
        select=select,
        exclude=exclude,
        layer_config=layer_config or LineageLayerConfig(),
        ui_config=ui_config or UiConfig(),
        column_lineage_enabled=column_lineage_enabled,
        column_lineage_select=column_lineage_select,
        column_lineage_depth=column_lineage_depth,
        column_lineage_cache_dir=column_lineage_cache_dir,
        column_lineage_workers=column_lineage_workers,
        exclude_packages=exclude_packages,
        slim=slim,
        enable_erd=enable_erd,
    )

    stages = default_stages(ctx)
    run_pipeline(stages, ctx)

    return context_to_dict(ctx)


def _build_column_lineage(
    enabled: bool,
    select: str | None,
    depth: int | None,
    cache_dir: Any | None,
    manifest: Any,
    models: dict[str, Any],
    sources: dict[str, Any],
    seeds: dict[str, Any],
    snapshots: dict[str, Any],
    max_workers: int | None = None,
) -> tuple[
    dict[str, Any] | None,
    dict[str, list[dict[str, str]]] | None,
    dict[str, str] | None,
    dict[str, list[dict[str, str]]] | None,
    dict[str, dict[str, Any]] | None,
]:
    """Build column-level lineage, join keys, bases, indirect parents, sql graphs.

    Returns:
        ``(column_lineage, join_keys, join_bases, join_indirect, sql_graphs)`` —
        all ``None`` when disabled.
    """
    if not enabled:
        return None, None, None, None, None

    from pathlib import Path as _Path

    from docglow.lineage.analyzer import analyze_column_lineage
    from docglow.lineage.column_parser import detect_dialect

    dialect = detect_dialect(manifest.metadata.adapter_type)

    subset = None
    if select:
        from docglow.lineage.analyzer import compute_column_lineage_subset

        subset = compute_column_lineage_subset(
            pattern=select,
            models=models,
            sources=sources,
            seeds=seeds,
            snapshots=snapshots,
            max_depth=depth,
        )

    result = analyze_column_lineage(
        models=models,
        sources=sources,
        seeds=seeds,
        snapshots=snapshots,
        dialect=dialect,
        manifest_nodes=dict(manifest.nodes),
        manifest_sources=dict(manifest.sources),
        cache_path=(
            _Path(cache_dir) / ".docglow-column-lineage-cache.json"
            if cache_dir
            else _Path(".docglow-column-lineage-cache.json")
        ),
        subset=subset,
        max_workers=max_workers,
    )

    column_lineage = result.lineage
    join_keys = result.join_keys
    join_bases = result.join_bases
    join_indirect = result.join_indirect
    sql_graphs = result.sql_graphs

    # Backfill columns for models that have lineage but no catalog/manifest columns.
    if column_lineage:
        _backfill_columns_from_lineage(column_lineage, models, seeds, snapshots)

    return (
        column_lineage,
        join_keys or None,
        join_bases or None,
        join_indirect or None,
        sql_graphs or None,
    )


def enrich_lineage_edges_with_join_keys(
    lineage: dict[str, Any],
    join_keys: dict[str, list[dict[str, str]]] | None,
) -> None:
    """Attach join_keys onto lineage edges when both endpoints match a pair.

    Mutates ``lineage["edges"]`` in place. Sibling-only pairs (no matching
    depends_on edge) remain available via the top-level ``join_keys`` map.
    """
    if not join_keys or not lineage.get("edges"):
        return

    # Index pairs by frozenset of the two model ids for O(1) edge lookup.
    by_endpoints: dict[frozenset[str], list[dict[str, str]]] = {}
    for pairs in join_keys.values():
        for pair in pairs:
            left = pair.get("left_model")
            right = pair.get("right_model")
            if not left or not right:
                continue
            key = frozenset({left, right})
            by_endpoints.setdefault(key, []).append(pair)

    if not by_endpoints:
        return

    enriched: list[dict[str, Any]] = []
    for edge in lineage["edges"]:
        source = edge.get("source")
        target = edge.get("target")
        if not source or not target:
            enriched.append(edge)
            continue
        pairs = by_endpoints.get(frozenset({source, target}))
        if not pairs:
            enriched.append(edge)
            continue
        edge_keys: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for pair in pairs:
            if pair["left_model"] == source and pair["right_model"] == target:
                sc, tc = pair["left_column"], pair["right_column"]
            elif pair["right_model"] == source and pair["left_model"] == target:
                sc, tc = pair["right_column"], pair["left_column"]
            else:
                continue
            marker = (sc, tc)
            if marker in seen:
                continue
            seen.add(marker)
            edge_keys.append({"source_column": sc, "target_column": tc})
        if edge_keys:
            enriched.append({**edge, "join_keys": edge_keys})
        else:
            enriched.append(edge)

    lineage["edges"] = enriched


def _backfill_columns_from_lineage(
    column_lineage: dict[str, dict[str, list[dict[str, str]]]],
    *collections: dict[str, Any],
) -> None:
    """Add placeholder column entries for models that have lineage but no columns.

    Dynamic Tables and uncompiled models often have no catalog or manifest
    column data, but column lineage analysis can still resolve their output
    columns from CTE definitions. This backfills the model's ``columns``
    list so the frontend can display them.
    """
    for collection in collections:
        for uid, model_data in collection.items():
            if uid not in column_lineage:
                continue
            if model_data.get("columns"):
                continue  # Already has columns

            lineage_cols = column_lineage[uid]
            model_data["columns"] = [
                {
                    "name": col_name,
                    "description": "",
                    "data_type": "",
                    "meta": {},
                    "tags": [],
                    "tests": [],
                    "profile": None,
                }
                for col_name in sorted(lineage_cols.keys())
            ]
