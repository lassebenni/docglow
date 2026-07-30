"""High-level column lineage analysis — ties together parsing and resolution."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import logging
import os
import re
from collections import deque
from collections.abc import Iterator, Mapping
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docglow import __version__
from docglow.lineage.column_parser import (
    ColumnDependency,
    build_schema_mapping,
    parse_column_lineage,
)
from docglow.lineage.join_keys import (
    UnresolvedIndirectJoinParent,
    UnresolvedJoinKeyPair,
    extract_indirect_join_parents,
    extract_join_base_table,
    extract_join_pairs,
)
from docglow.lineage.macro_expander import expand_macros
from docglow.lineage.sql_graph import build_sql_graph
from docglow.lineage.table_resolver import TableResolver

logger = logging.getLogger(__name__)

# Bumped when cached lineage semantics change (e.g. sql_graph richer ops + passthrough).
_CACHE_FORMAT_VERSION = 10

# Patterns for stripping Jinja from raw dbt SQL
_JINJA_CONFIG = re.compile(r"\{\{\s*config\s*\(.*?\)\s*\}\}", re.DOTALL)
_JINJA_REF = re.compile(r"\{\{\s*ref\s*\(\s*['\"]([^'\"]+)['\"]\s*\)\s*\}\}")
_JINJA_SOURCE = re.compile(
    r"\{\{\s*source\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)\s*\}\}"
)
_JINJA_GENERIC = re.compile(r"\{\{.*?\}\}", re.DOTALL)
_JINJA_BLOCK = re.compile(r"\{%.*?%\}", re.DOTALL)


@dataclass(frozen=True)
class ColumnLineageResult(Mapping[str, dict[str, list[dict[str, str]]]]):
    """Project-wide column lineage + join-key analysis result.

    Implements Mapping so existing callers that treat the return value as
    ``{model_uid: {column: deps}}`` keep working; use ``.join_keys`` for pairs
    and ``.join_bases`` for the FROM (foundation) parent of each model's joins.
    """

    lineage: dict[str, dict[str, list[dict[str, str]]]]
    join_keys: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    join_bases: dict[str, str] = field(default_factory=dict)
    join_indirect: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    sql_graphs: dict[str, dict[str, Any]] = field(default_factory=dict)

    def __getitem__(self, key: str) -> dict[str, list[dict[str, str]]]:
        return self.lineage[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self.lineage)

    def __len__(self) -> int:
        return len(self.lineage)


@dataclass
class _ModelLineageResult:
    """Result of analyzing column lineage for a single model."""

    uid: str
    lineage: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    join_keys: list[dict[str, str]] = field(default_factory=list)
    join_base: str | None = None
    join_indirect: list[dict[str, str]] = field(default_factory=list)
    sql_graph: dict[str, Any] | None = None
    cache_entry: dict[str, Any] = field(default_factory=dict)
    failure: dict[str, str] | None = None
    cached: bool = False
    skipped: bool = False


def _compute_depth_waves(
    all_models: dict[str, dict[str, Any]],
) -> list[list[str]]:
    """Compute topological depth waves for parallel processing.

    Returns a list of waves, where each wave contains model UIDs that can be
    processed in parallel (all their upstream dependencies are in earlier waves).

    Models with no in-set dependencies are in wave 0. Models whose dependencies
    are all outside the set (e.g. sources) are also in wave 0.
    """
    model_uids = set(all_models.keys())

    # Build in-degree map: only count dependencies that are within our model set
    in_degree: dict[str, int] = {}
    dependents: dict[str, list[str]] = {uid: [] for uid in model_uids}

    for uid, data in all_models.items():
        deps_in_set = [d for d in data.get("depends_on", []) if d in model_uids]
        in_degree[uid] = len(deps_in_set)
        for dep in deps_in_set:
            dependents[dep].append(uid)

    # BFS from roots (in-degree 0) to assign depth
    waves: list[list[str]] = []
    current_wave = [uid for uid, deg in in_degree.items() if deg == 0]

    while current_wave:
        waves.append(current_wave)
        next_wave: list[str] = []
        for uid in current_wave:
            for dependent in dependents[uid]:
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    next_wave.append(dependent)
        current_wave = next_wave

    # Any remaining models (cycles) go in a final wave
    processed = {uid for wave in waves for uid in wave}
    remaining = [uid for uid in model_uids if uid not in processed]
    if remaining:
        waves.append(remaining)

    return waves


# Module-level state for worker processes (set by _init_worker)
_worker_schema: dict[str, dict[str, str]] = {}
_worker_resolver: TableResolver | None = None
_worker_dialect: str | None = None


def _init_worker(
    schema: dict[str, dict[str, str]],
    resolver: TableResolver,
    dialect: str | None,
) -> None:
    """Initialize shared read-only state in each worker process."""
    global _worker_schema, _worker_resolver, _worker_dialect  # noqa: PLW0603
    _worker_schema = schema
    _worker_resolver = resolver
    _worker_dialect = dialect


def _analyze_model_in_worker(
    uid: str,
    data: dict[str, Any],
    cached_entry: dict[str, Any] | None,
) -> _ModelLineageResult:
    """Wrapper for _analyze_single_model that uses process-local shared state."""
    return _analyze_single_model(
        uid=uid,
        data=data,
        schema=_worker_schema,
        resolver=_worker_resolver,  # type: ignore[arg-type]
        dialect=_worker_dialect,
        cached_entry=cached_entry,
    )


def _analyze_single_model(
    uid: str,
    data: dict[str, Any],
    schema: dict[str, dict[str, str]],
    resolver: TableResolver,
    dialect: str | None,
    cached_entry: dict[str, Any] | None,
) -> _ModelLineageResult:
    """Analyze column lineage for a single model. Pure function, no side effects.

    All inputs are read-only. Returns a result struct that the caller merges
    into shared state.
    """
    sql = data.get("compiled_sql", "")
    if not sql:
        raw = data.get("raw_sql", "")
        if not raw:
            return _ModelLineageResult(uid=uid, skipped=True)
        if "{{" in raw or "{%" in raw:
            sql = strip_jinja(raw)
        else:
            sql = raw

    if not sql or not sql.strip():
        return _ModelLineageResult(uid=uid, skipped=True)

    sql_hash = _hash_sql(sql)

    # Check cache
    if cached_entry and cached_entry.get("sql_hash") == sql_hash:
        cached_lineage = cached_entry.get("lineage")
        cached_joins = cached_entry.get("join_keys") or []
        cached_base = cached_entry.get("join_base")
        cached_indirect = cached_entry.get("join_indirect") or []
        cached_graph = cached_entry.get("sql_graph")
        return _ModelLineageResult(
            uid=uid,
            lineage=cached_lineage or {},
            join_keys=list(cached_joins) if isinstance(cached_joins, list) else [],
            join_base=cached_base if isinstance(cached_base, str) else None,
            join_indirect=(list(cached_indirect) if isinstance(cached_indirect, list) else []),
            sql_graph=cached_graph if isinstance(cached_graph, dict) else None,
            cached=True,
        )

    known_columns = [col["name"] for col in data.get("columns", []) if col.get("name")]

    try:
        raw_lineage = parse_column_lineage(
            compiled_sql=sql,
            schema=schema,
            dialect=dialect,
            known_columns=known_columns or None,
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("Failed to parse column lineage for %s: %s", uid, e)
        return _ModelLineageResult(
            uid=uid,
            cache_entry={
                "sql_hash": sql_hash,
                "lineage": {},
                "join_keys": [],
                "join_base": None,
                "join_indirect": [],
                "sql_graph": None,
            },
            failure={
                "model": uid,
                "name": data.get("name", ""),
                "error": str(e),
            },
        )

    resolved_joins = _resolve_join_keys(sql, dialect, resolver)
    join_base = _resolve_join_base(sql, dialect, resolver)
    join_indirect = _resolve_indirect_join_parents(sql, dialect, resolver)
    sql_graph = build_sql_graph(
        sql,
        model_uid=uid,
        model_name=data.get("name", uid.rsplit(".", 1)[-1]),
        resolver=resolver,
        dialect=dialect,
        schema=schema,
        output_columns=known_columns or None,
    )

    if not raw_lineage:
        failure = None
        model_lineage: dict[str, list[dict[str, str]]] = {}
        if known_columns:
            model_lineage = {c: [{"transformation": "untraced"}] for c in known_columns}
            failure = {
                "model": uid,
                "name": data.get("name", ""),
                "error": f"No columns traced ({len(known_columns)} columns in schema)",
            }
        return _ModelLineageResult(
            uid=uid,
            lineage=model_lineage,
            join_keys=resolved_joins,
            join_base=join_base,
            join_indirect=join_indirect,
            sql_graph=sql_graph,
            cache_entry={
                "sql_hash": sql_hash,
                "lineage": model_lineage,
                "join_keys": resolved_joins,
                "join_base": join_base,
                "join_indirect": join_indirect,
                "sql_graph": sql_graph,
            },
            failure=failure,
        )

    model_lineage = _resolve_dependencies(raw_lineage, resolver)

    # Catalog columns with no parse result → explicit untraced markers (not silent gaps).
    if known_columns:
        for col in known_columns:
            if col not in model_lineage:
                model_lineage[col] = [{"transformation": "untraced"}]

    cache_entry_out = {
        "sql_hash": sql_hash,
        "lineage": model_lineage,
        "join_keys": resolved_joins,
        "join_base": join_base,
        "join_indirect": join_indirect,
        "sql_graph": sql_graph,
    }

    # Track partially traced models (untraced still counts as a soft failure for the log)
    failure = None
    if known_columns:
        untraced = [
            c
            for c, deps in model_lineage.items()
            if deps and all(d.get("transformation") == "untraced" for d in deps)
        ]
        if untraced:
            failure = {
                "model": uid,
                "name": data.get("name", ""),
                "error": f"Partial: {len(untraced)}/{len(known_columns)} columns not traced",
                "columns": ", ".join(untraced[:20]),
            }

    return _ModelLineageResult(
        uid=uid,
        lineage=model_lineage,
        join_keys=resolved_joins,
        join_base=join_base,
        join_indirect=join_indirect,
        sql_graph=sql_graph,
        cache_entry=cache_entry_out,
        failure=failure,
    )


def _resolve_join_keys(
    sql: str,
    dialect: str | None,
    resolver: TableResolver,
) -> list[dict[str, str]]:
    """Extract and resolve join-key pairs for a single model's SQL."""
    unresolved = extract_join_pairs(sql, dialect=dialect)
    return resolve_join_key_pairs(unresolved, resolver)


def _resolve_join_base(
    sql: str,
    dialect: str | None,
    resolver: TableResolver,
) -> str | None:
    """Extract and resolve the FROM (foundation) parent of the primary JOIN."""
    base_ref = extract_join_base_table(sql, dialect=dialect)
    if not base_ref:
        return None
    return resolver.resolve(base_ref)


def _resolve_indirect_join_parents(
    sql: str,
    dialect: str | None,
    resolver: TableResolver,
) -> list[dict[str, str]]:
    """Extract and resolve parents reached only via joined aggregate/CTE blocks."""
    unresolved = extract_indirect_join_parents(sql, dialect=dialect)
    return resolve_indirect_join_parents(unresolved, resolver)


def resolve_join_key_pairs(
    pairs: list[UnresolvedJoinKeyPair],
    resolver: TableResolver,
) -> list[dict[str, str]]:
    """Resolve unresolved join pairs to dbt unique_ids; drop unresolved sides."""
    resolved: list[dict[str, str]] = []
    for pair in pairs:
        left_uid = resolver.resolve(pair.left_table)
        right_uid = resolver.resolve(pair.right_table)
        if not left_uid or not right_uid:
            continue
        entry: dict[str, str] = {
            "left_model": left_uid,
            "left_column": pair.left_column,
            "right_model": right_uid,
            "right_column": pair.right_column,
        }
        if pair.join_type:
            entry["join_type"] = pair.join_type
        resolved.append(entry)
    return resolved


def resolve_indirect_join_parents(
    parents: list[UnresolvedIndirectJoinParent],
    resolver: TableResolver,
) -> list[dict[str, str]]:
    """Resolve indirect join parents to dbt unique_ids."""
    resolved: list[dict[str, str]] = []
    seen: set[str] = set()
    for parent in parents:
        uid = resolver.resolve(parent.table)
        if not uid or uid in seen:
            continue
        seen.add(uid)
        resolved.append({"model": uid, "kind": parent.kind})
    return resolved


def serialize_shared_state(
    models: dict[str, dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    seeds: dict[str, dict[str, Any]],
    snapshots: dict[str, dict[str, Any]],
    dialect: str | None = None,
    manifest_nodes: dict[str, Any] | None = None,
    manifest_sources: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the project-wide shared state once and return it JSON-serializable.

    This is the build-once half of the per-model analysis seam: a coordinator
    calls it a single time, ships the returned blob to per-model workers, and
    each worker rehydrates it with :func:`deserialize_shared_state` before
    calling :func:`analyze_one_model`.

    The ``resolver`` and ``schema`` are built with exactly the same constructor
    calls as :func:`analyze_column_lineage`, so the per-model path produces
    identical lineage to the whole-project path.

    The state is intentionally serialized via ``TableResolver.to_dict()`` (plain
    string dicts) rather than pickle: it is only ``dict[str, str]`` data, so JSON
    is safe, and a versioned dict shape is far more durable across OSS versions
    than a pickle of a class instance.

    Args:
        models: Transformed model data from build_docglow_data.
        sources: Transformed source data.
        seeds: Transformed seed data.
        snapshots: Transformed snapshot data.
        dialect: SQL dialect for parsing.
        manifest_nodes: Raw manifest nodes (for relation_name resolution).
        manifest_sources: Raw manifest sources (for relation_name resolution).

    Returns:
        A JSON-serializable dict: ``{"resolver": <to_dict>, "schema": <mapping>,
        "dialect": <dialect>}``.
    """
    resolver = TableResolver(
        models=models,
        sources=sources,
        seeds=seeds,
        snapshots=snapshots,
        manifest_nodes=manifest_nodes,
        manifest_sources=manifest_sources,
    )
    schema = build_schema_mapping(models, sources)
    return {
        "resolver": resolver.to_dict(),
        "schema": schema,
        "dialect": dialect,
    }


def deserialize_shared_state(
    blob: dict[str, Any],
) -> tuple[TableResolver, dict[str, dict[str, str]], str | None]:
    """Reconstruct ``(resolver, schema, dialect)`` from a serialized blob.

    Inverse of :func:`serialize_shared_state`. The returned tuple is the
    ``shared_state`` argument expected by :func:`analyze_one_model`.

    Args:
        blob: The dict produced by :func:`serialize_shared_state`.

    Returns:
        A ``(resolver, schema, dialect)`` tuple.
    """
    resolver = TableResolver.from_dict(blob["resolver"])
    schema: dict[str, dict[str, str]] = blob.get("schema", {})
    dialect: str | None = blob.get("dialect")
    return resolver, schema, dialect


def analyze_one_model(
    uid: str,
    model_data: dict[str, Any],
    shared_state: tuple[TableResolver, dict[str, dict[str, str]], str | None],
) -> _ModelLineageResult:
    """Analyze column lineage for a single model given pre-built shared state.

    Public, importable per-model entrypoint that wraps the pure
    :func:`_analyze_single_model`. A downstream worker can analyze ONE model
    given the shared state produced by :func:`deserialize_shared_state`, without
    depending on private OSS internals or the whole-project pool path.

    This function NEVER raises on a malformed/unparseable model.
    ``_analyze_single_model`` already catches parse exceptions and returns the
    result with its ``failure`` field populated; this wrapper preserves that
    contract and adds a top-level guard so that any unexpected escape still
    becomes a structured per-model failure rather than an exception.

    Caching is intentionally disabled here (``cached_entry=None``): the per-model
    fan-out path treats every dispatched model as fresh work.

    Args:
        uid: The model's dbt unique_id.
        model_data: The transformed model dict (carrying ``compiled_sql`` /
            ``raw_sql`` / ``columns`` / ``name``).
        shared_state: The ``(resolver, schema, dialect)`` tuple from
            :func:`deserialize_shared_state`.

    Returns:
        A :class:`_ModelLineageResult` carrying ``.lineage`` (the
        ``{col: [dep_dict]}`` fragment for this uid), ``.failure``,
        ``.skipped``, and ``.cache_entry``.
    """
    resolver, schema, dialect = shared_state
    try:
        return _analyze_single_model(
            uid=uid,
            data=model_data,
            schema=schema,
            resolver=resolver,
            dialect=dialect,
            cached_entry=None,
        )
    except Exception as e:  # noqa: BLE001
        # Defensive backstop: _analyze_single_model already converts parse
        # failures into a result.failure, so this should be unreachable for
        # SQL-parse errors. Guards against any other unexpected escape so the
        # caller always gets a structured failure, never a raised exception.
        logger.debug("Unexpected error analyzing %s: %s", uid, e)
        return _ModelLineageResult(
            uid=uid,
            failure={
                "model": uid,
                "name": model_data.get("name", ""),
                "error": str(e),
            },
        )


def analyze_column_lineage(
    models: dict[str, dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    seeds: dict[str, dict[str, Any]],
    snapshots: dict[str, dict[str, Any]],
    dialect: str | None = None,
    manifest_nodes: dict[str, Any] | None = None,
    manifest_sources: dict[str, Any] | None = None,
    cache_path: Path | None = None,
    subset: set[str] | None = None,
    max_workers: int | None = None,
) -> ColumnLineageResult:
    """Analyze column-level lineage for all models.

    Uses compiled_sql when available, falls back to raw_sql with Jinja
    stripped for models that haven't been compiled.

    When the model count exceeds the parallel threshold, models are processed
    concurrently using a process pool (bypasses the GIL for CPU-bound SQLGlot
    parsing). Below the threshold or with max_workers=1, models run sequentially
    in topological order.

    Args:
        models: Transformed model data from build_docglow_data.
        sources: Transformed source data.
        seeds: Transformed seed data.
        snapshots: Transformed snapshot data.
        dialect: SQL dialect for parsing.
        manifest_nodes: Raw manifest nodes (for relation_name resolution).
        manifest_sources: Raw manifest sources (for relation_name resolution).
        cache_path: Path to the column lineage cache file.
        subset: If provided, only analyze these model unique_ids.
            Models outside the subset still have their cached results included.
        max_workers: Max parallel workers for lineage parsing.
            Defaults to min(8, cpu_count). Set to 1 for sequential.

    Returns:
        ColumnLineageResult with lineage and join_keys maps keyed by model uid.
    """
    resolver = TableResolver(
        models=models,
        sources=sources,
        seeds=seeds,
        snapshots=snapshots,
        manifest_nodes=manifest_nodes,
        manifest_sources=manifest_sources,
    )
    schema = build_schema_mapping(models, sources)

    # Load cache if available
    cache = _load_cache(cache_path, dialect)
    cache_hits = 0

    column_lineage: dict[str, dict[str, list[dict[str, str]]]] = {}
    join_keys: dict[str, list[dict[str, str]]] = {}
    join_bases: dict[str, str] = {}
    join_indirect: dict[str, list[dict[str, str]]] = {}
    sql_graphs: dict[str, dict[str, Any]] = {}
    parse_failures = 0
    total_models = 0
    failure_details: list[dict[str, str]] = []

    all_models = {**models, **seeds, **snapshots}

    if subset is not None:
        logger.info(
            "Column lineage: subset selection active (%d/%d models)",
            len(subset & set(all_models.keys())),
            len(all_models),
        )

    # Subset filtering: include cached results for models outside subset
    if subset is not None:
        for uid in all_models:
            if uid not in subset:
                cached_entry = cache.get(uid)
                if cached_entry and cached_entry.get("lineage"):
                    column_lineage[uid] = cached_entry["lineage"]
                if cached_entry and cached_entry.get("join_keys"):
                    join_keys[uid] = list(cached_entry["join_keys"])
                cached_base = cached_entry.get("join_base") if cached_entry else None
                if isinstance(cached_base, str) and cached_base:
                    join_bases[uid] = cached_base
                cached_indirect = cached_entry.get("join_indirect") if cached_entry else None
                if isinstance(cached_indirect, list) and cached_indirect:
                    join_indirect[uid] = list(cached_indirect)
                cached_graph = cached_entry.get("sql_graph") if cached_entry else None
                if isinstance(cached_graph, dict) and cached_graph:
                    sql_graphs[uid] = cached_graph

    # Determine which models to analyze
    uids_to_analyze = (
        [uid for uid in all_models if uid in subset]
        if subset is not None
        else list(all_models.keys())
    )
    analyzable_count = len(uids_to_analyze)

    # Process pool has meaningful startup cost (fork + serialize schema/resolver),
    # so only use it when there are enough models to amortize the overhead.
    parallel_threshold = 20
    workers = max_workers if max_workers is not None else min(8, os.cpu_count() or 1)
    use_parallel = workers > 1 and analyzable_count >= parallel_threshold

    analyzed_count = 0

    if use_parallel:
        logger.info(
            "Column lineage: %d models, %d workers",
            analyzable_count,
            workers,
        )

        # Submit all models to the pool at once. Each model's parsing is
        # independent (uses only its own SQL + the shared schema/resolver).
        # Note: each model's data dict is pickled per submit() call — the
        # compiled_sql strings dominate IPC cost for large models.
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_init_worker,
            initargs=(schema, resolver, dialect),
        ) as pool:
            futures = {
                pool.submit(
                    _analyze_model_in_worker,
                    uid,
                    all_models[uid],
                    cache.get(uid),
                ): uid
                for uid in uids_to_analyze
            }

            for future in as_completed(futures):
                result = future.result()
                analyzed_count += 1
                _merge_result(
                    result,
                    all_models,
                    column_lineage,
                    join_keys,
                    join_bases,
                    join_indirect,
                    sql_graphs,
                    cache,
                    failure_details,
                    analyzed_count,
                    analyzable_count,
                )
                if not result.skipped:
                    total_models += 1
                    if result.cached:
                        cache_hits += 1
                    elif result.failure:
                        parse_failures += 1
    else:
        # Sequential: process in topological order (upstream before downstream)
        waves = _compute_depth_waves({uid: all_models[uid] for uid in uids_to_analyze})
        for wave_uids in waves:
            for uid in wave_uids:
                result = _analyze_single_model(
                    uid=uid,
                    data=all_models[uid],
                    schema=schema,
                    resolver=resolver,
                    dialect=dialect,
                    cached_entry=cache.get(uid),
                )
                analyzed_count += 1
                _merge_result(
                    result,
                    all_models,
                    column_lineage,
                    join_keys,
                    join_bases,
                    join_indirect,
                    sql_graphs,
                    cache,
                    failure_details,
                    analyzed_count,
                    analyzable_count,
                )
                if not result.skipped:
                    total_models += 1
                    if result.cached:
                        cache_hits += 1
                    elif result.failure:
                        parse_failures += 1

    if parse_failures > 0:
        logger.warning(
            "Column lineage: %d/%d models could not be analyzed",
            parse_failures,
            total_models,
        )

    logger.info(
        "Column lineage: analyzed %d models (%d cached), %d with column dependencies",
        total_models,
        cache_hits,
        len(column_lineage),
    )

    # Save updated cache
    _save_cache(cache_path, cache, dialect)

    # Write failure report if there were issues
    if failure_details:
        _write_failure_report(failure_details, cache_path)

    return ColumnLineageResult(
        lineage=column_lineage,
        join_keys=join_keys,
        join_bases=join_bases,
        join_indirect=join_indirect,
        sql_graphs=sql_graphs,
    )


def _merge_result(
    result: _ModelLineageResult,
    all_models: dict[str, dict[str, Any]],
    column_lineage: dict[str, dict[str, list[dict[str, str]]]],
    join_keys: dict[str, list[dict[str, str]]],
    join_bases: dict[str, str],
    join_indirect: dict[str, list[dict[str, str]]],
    sql_graphs: dict[str, dict[str, Any]],
    cache: dict[str, Any],
    failure_details: list[dict[str, str]],
    analyzed_count: int,
    analyzable_count: int,
) -> None:
    """Merge a single model's lineage result into shared state.

    Called sequentially (after future.result() in parallel mode, or directly
    in sequential mode) so no locking is needed.
    """
    if result.skipped:
        return

    if result.cached:
        if result.lineage:
            column_lineage[result.uid] = result.lineage
        if result.join_keys:
            join_keys[result.uid] = result.join_keys
        if result.join_base:
            join_bases[result.uid] = result.join_base
        if result.join_indirect:
            join_indirect[result.uid] = result.join_indirect
        if result.sql_graph:
            sql_graphs[result.uid] = result.sql_graph
        return

    model_name = all_models[result.uid].get("name", result.uid.split(".")[-1])
    logger.info(
        "Column lineage: analyzed %s (%d/%d)",
        model_name,
        analyzed_count,
        analyzable_count,
    )

    if result.cache_entry:
        cache[result.uid] = result.cache_entry
    if result.lineage:
        column_lineage[result.uid] = result.lineage
    if result.join_keys:
        join_keys[result.uid] = result.join_keys
    if result.join_base:
        join_bases[result.uid] = result.join_base
    if result.join_indirect:
        join_indirect[result.uid] = result.join_indirect
    if result.sql_graph:
        sql_graphs[result.uid] = result.sql_graph
    if result.failure:
        failure_details.append(result.failure)


def strip_jinja(raw_sql: str) -> str:
    """Strip Jinja templating from raw dbt SQL to make it parseable.

    - {{ config(...) }} -> removed entirely
    - {{ ref('model_name') }} -> model_name
    - {{ source('source', 'table') }} -> source.table
    - {{ other_macro(...) }} -> NULL (placeholder to keep SQL valid)
    - {% ... %} blocks -> removed
    """
    sql = _JINJA_CONFIG.sub("", raw_sql)
    sql = _JINJA_REF.sub(r"\1", sql)
    sql = _JINJA_SOURCE.sub(r"\1.\2", sql)
    sql = expand_macros(sql)
    sql = _JINJA_GENERIC.sub("NULL", sql)
    sql = _JINJA_BLOCK.sub("", sql)
    return sql


def compute_column_lineage_subset(
    pattern: str,
    models: dict[str, dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    seeds: dict[str, dict[str, Any]],
    snapshots: dict[str, dict[str, Any]],
    max_depth: int | None = None,
) -> set[str]:
    """Compute the set of model unique_ids to analyze for column lineage.

    Supports the same ``+name`` / ``name+`` direction syntax as ``--select``:
      - ``fct_orders`` or ``+fct_orders`` — the model and its upstream dependencies
      - ``fct_orders+`` — the model and its downstream consumers
      - ``+fct_orders+`` — both directions

    Glob patterns are supported (e.g. ``fct_*``).

    Args:
        pattern: Model name pattern with optional direction operators.
        models: Transformed model data.
        sources: Transformed source data.
        seeds: Transformed seed data.
        snapshots: Transformed snapshot data.
        max_depth: Maximum hops to traverse. None means unlimited.

    Returns:
        Set of unique_ids to include in column lineage analysis.
    """
    include_upstream = not pattern.endswith("+") or pattern.startswith("+")
    include_downstream = pattern.endswith("+")

    # Default (no + at all) is upstream only
    if "+" not in pattern:
        include_upstream = True
        include_downstream = False

    clean = pattern.strip("+")

    all_resources = {**models, **seeds, **snapshots}

    # Match seed models by name, folder, or path
    matched: set[str] = set()
    for uid, data in all_resources.items():
        name = data.get("name", "")
        folder = data.get("folder", "")
        path = data.get("path", "")
        if (
            fnmatch.fnmatch(name, clean)
            or fnmatch.fnmatch(folder, clean)
            or fnmatch.fnmatch(path, clean)
        ):
            matched.add(uid)

    if not matched:
        logger.warning("Column lineage subset: no models matched pattern '%s'", clean)
        return set()

    # BFS walk
    result: set[str] = set(matched)

    if include_upstream:
        _bfs_walk(matched, all_resources, sources, result, "depends_on", max_depth)

    if include_downstream:
        _bfs_walk(matched, all_resources, sources, result, "referenced_by", max_depth)

    logger.info(
        "Column lineage subset: '%s' matched %d seed models, %d total after traversal",
        pattern,
        len(matched),
        len(result),
    )

    return result


def _bfs_walk(
    seed_ids: set[str],
    all_resources: dict[str, dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    result: set[str],
    key: str,
    max_depth: int | None,
) -> None:
    """BFS walk through the dependency graph in a given direction."""
    queue: deque[tuple[str, int]] = deque((uid, 0) for uid in seed_ids)

    while queue:
        uid, depth = queue.popleft()
        if max_depth is not None and depth >= max_depth:
            continue

        # Get neighbors from model data or source data
        resource = all_resources.get(uid) or sources.get(uid)
        if not resource:
            continue

        for neighbor in resource.get(key, []):
            if neighbor not in result:
                result.add(neighbor)
                queue.append((neighbor, depth + 1))


def _resolve_dependencies(
    raw_lineage: dict[str, list[ColumnDependency]],
    resolver: TableResolver,
) -> dict[str, list[dict[str, str]]]:
    """Resolve table references in parsed lineage to dbt unique_ids."""
    resolved: dict[str, list[dict[str, str]]] = {}

    for col_name, deps in raw_lineage.items():
        resolved_deps: list[dict[str, str]] = []
        for dep in deps:
            if dep.transformation == "constant":
                entry: dict[str, str] = {"transformation": "constant"}
                if dep.expression:
                    entry["expression"] = dep.expression
                resolved_deps.append(entry)
                continue

            if dep.transformation == "untraced":
                resolved_deps.append({"transformation": "untraced"})
                continue

            if not dep.source_table:
                continue

            source_model = resolver.resolve(dep.source_table)
            if source_model is None:
                # Unresolvable — could be a CTE or external table
                continue

            entry = {
                "source_model": source_model,
                "source_column": dep.source_column,
                "transformation": dep.transformation,
            }
            if dep.expression and dep.transformation in ("derived", "aggregated"):
                entry["expression"] = dep.expression
            resolved_deps.append(entry)

        if resolved_deps:
            resolved[col_name] = resolved_deps

    return resolved


def _hash_sql(sql: str) -> str:
    """Compute a stable hash of SQL text for cache keying."""
    return hashlib.sha256(sql.encode("utf-8")).hexdigest()[:16]


_CACHE_VERSION_KEY = "__cache_meta__"


def _load_cache(
    cache_path: Path | None,
    dialect: str | None,
) -> dict[str, Any]:
    """Load the column lineage cache from disk. Returns empty dict on any error."""
    if not cache_path or not cache_path.exists():
        return {}

    try:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.debug("Column lineage cache is invalid, starting fresh")
        return {}

    if not isinstance(raw, dict):
        return {}

    # Invalidate if version, dialect, or cache format changed
    meta = raw.get(_CACHE_VERSION_KEY, {})
    if (
        meta.get("docglow_version") != __version__
        or meta.get("dialect") != dialect
        or meta.get("cache_format") != _CACHE_FORMAT_VERSION
    ):
        logger.debug("Column lineage cache invalidated (version/dialect/format change)")
        return {}

    # Remove meta key and migrate legacy "direct" → "passthrough"
    cache = {k: v for k, v in raw.items() if k != _CACHE_VERSION_KEY}
    _migrate_direct_to_passthrough(cache)
    return cache


def _migrate_direct_to_passthrough(cache: dict[str, Any]) -> None:
    """Migrate legacy 'direct' transformation values to 'passthrough'.

    Prior to the transformation reclassification (DOC-76), simple column
    references were labelled 'direct'. This rewrites them in-place so
    downstream code only sees the new vocabulary.
    """
    for entry in cache.values():
        if not isinstance(entry, dict):
            continue
        lineage = entry.get("lineage")
        if not isinstance(lineage, dict):
            continue
        for deps in lineage.values():
            if not isinstance(deps, list):
                continue
            for dep in deps:
                if isinstance(dep, dict) and dep.get("transformation") == "direct":
                    dep["transformation"] = "passthrough"


def _save_cache(
    cache_path: Path | None,
    cache: dict[str, Any],
    dialect: str | None,
) -> None:
    """Save the column lineage cache to disk."""
    if not cache_path:
        return

    data = {
        _CACHE_VERSION_KEY: {
            "docglow_version": __version__,
            "dialect": dialect,
            "cache_format": _CACHE_FORMAT_VERSION,
        },
        **cache,
    }

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    except OSError:
        logger.debug("Failed to write column lineage cache")


def _write_failure_report(
    failures: list[dict[str, str]],
    cache_path: Path | None,
) -> None:
    """Write a column lineage failure report alongside the cache file."""
    report_path = Path(".docglow-column-lineage-failures.log")
    if cache_path:
        report_path = cache_path.parent / ".docglow-column-lineage-failures.log"

    lines = [
        "# Column Lineage — Failure Report",
        f"# {len(failures)} models with issues",
        "#",
        "# Common causes:",
        "#   - Snowflake variant access syntax (obj:key::type)",
        "#   - Complex macros that couldn't be expanded to SQL",
        "#   - Columns missing from catalog (run `dbt docs generate`)",
        "",
    ]

    for entry in sorted(failures, key=lambda x: x.get("name", "")):
        lines.append(f"{entry.get('name', '')}  ({entry.get('model', '')})")
        lines.append(f"  {entry.get('error', 'Unknown error')}")
        if entry.get("columns"):
            lines.append(f"  Columns: {entry['columns']}")
        lines.append("")

    try:
        report_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info(
            "Column lineage: %d models with issues — see %s",
            len(failures),
            report_path,
        )
    except OSError:
        logger.debug("Failed to write column lineage failure report")
