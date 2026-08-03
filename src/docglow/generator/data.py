"""Transform dbt artifacts into the unified DocglowData JSON payload."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from docglow.artifacts.loader import LoadedArtifacts
from docglow.config import UiConfig
from docglow.generator.layers import LineageLayerConfig

logger = logging.getLogger(__name__)


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
    exposure_field_lineage_path: Any | None = None,
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
        exposure_field_lineage_path=exposure_field_lineage_path,
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
    exposure_field_lineage_path: Any | None = None,
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

    from docglow.lineage.analyzer import analyze_column_lineage, compute_column_lineage_subset
    from docglow.lineage.column_parser import detect_dialect

    dialect = detect_dialect(manifest.metadata.adapter_type)

    subset = None
    if select:
        subset = compute_column_lineage_subset(
            pattern=select,
            models=models,
            sources=sources,
            seeds=seeds,
            snapshots=snapshots,
            max_depth=depth,
        )

    # Marts that only appear via exposure field lineage (e.g. Power BI measures)
    # must be analyzed too — otherwise Field path stops at those leaves.
    if subset is not None and exposure_field_lineage_path is not None:
        from docglow.lineage.exposure_field_lineage import (
            collect_mart_model_names,
            load_exposure_field_lineage,
        )

        sidecar = load_exposure_field_lineage(_Path(exposure_field_lineage_path))
        mart_names = collect_mart_model_names(sidecar)
        if mart_names:
            before = len(subset)
            for name in sorted(mart_names):
                subset |= compute_column_lineage_subset(
                    pattern=name,
                    models=models,
                    sources=sources,
                    seeds=seeds,
                    snapshots=snapshots,
                    max_depth=depth,
                )
            logger.info(
                "Expanded column lineage subset with %d exposure field lineage "
                "mart model(s): %d → %d unique_ids",
                len(mart_names),
                before,
                len(subset),
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
    """No-op — join keys are canonical on the top-level ``join_keys`` map only.

    Kept for call-site compatibility during the transition; does not mutate edges.
    """
    return


def _backfill_columns_from_lineage(
    column_lineage: dict[str, dict[str, list[dict[str, str]]]],
    *collections: dict[str, Any],
) -> None:
    """Ensure models expose every column that column lineage references.

    Dynamic Tables and uncompiled models often have no catalog/manifest
    columns; incremental models may also omit columns that still appear in
    compiled SQL. Backfill placeholder entries so the frontend can render
    field-path rows (and sort matched fields to the top of scrollable nodes).
    """
    needed: dict[str, set[str]] = {}
    for uid, cols in column_lineage.items():
        bucket = needed.setdefault(uid, set())
        bucket.update(cols.keys())
        for deps in cols.values():
            for dep in deps:
                source_model = dep.get("source_model")
                source_column = dep.get("source_column")
                if (
                    isinstance(source_model, str)
                    and source_model
                    and isinstance(source_column, str)
                    and source_column
                ):
                    needed.setdefault(source_model, set()).add(source_column)

    placeholder: dict[str, Any] = {
        "description": "",
        "data_type": "",
        "meta": {},
        "tags": [],
        "tests": [],
        "profile": None,
    }

    for collection in collections:
        for uid, model_data in collection.items():
            want = needed.get(uid)
            if not want:
                continue
            columns = list(model_data.get("columns") or [])
            existing = {c.get("name") for c in columns if isinstance(c.get("name"), str)}
            missing = sorted(name for name in want if name not in existing)
            if not missing:
                continue
            for name in missing:
                columns.append({"name": name, **placeholder})
            model_data["columns"] = columns
