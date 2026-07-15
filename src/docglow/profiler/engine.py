"""Profiling query engine — executes profiling queries against the warehouse."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from docglow.profiler.cache import (
    get_cached_profiles,
    get_cached_profiling_meta,
    is_cached,
    load_cache,
    save_cache,
    update_cache,
)
from docglow.profiler.queries import (
    build_column_specs,
    build_histogram_query,
    build_row_count_query,
    build_stats_query,
    build_top_values_query,
    build_temporal_distribution_query,
)
from docglow.profiler.stats import (
    parse_histogram_rows,
    parse_stats_row,
    parse_top_values_rows,
)

logger = logging.getLogger(__name__)


class ProfilerError(Exception):
    """Raised when profiling fails."""


def _get_connection_url(adapter: str, connection_params: dict[str, Any]) -> str:
    """Build a SQLAlchemy connection URL from adapter type and params.

    Accepts either a DSN/URI string (via ``{"dsn": "..."}`` from CLI) or
    individual component params (host, port, user, etc.).
    """
    # If a DSN string was provided, pass it through directly — SQLAlchemy
    # accepts connection URIs natively for postgres, snowflake, etc.
    dsn = connection_params.get("dsn")
    if dsn:
        return str(dsn)

    if adapter == "duckdb":
        path = connection_params.get("path", ":memory:")
        return f"duckdb:///{path}"
    if adapter in ("postgres", "postgresql"):
        host = connection_params.get("host", "localhost")
        port = connection_params.get("port", 5432)
        user = connection_params.get("user", "")
        password = connection_params.get("password", "")
        dbname = connection_params.get("dbname", connection_params.get("database", ""))
        return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
    if adapter == "snowflake":
        account = connection_params.get("account", "")
        user = connection_params.get("user", "")
        password = connection_params.get("password", "")
        database = connection_params.get("database", "")
        warehouse = connection_params.get("warehouse", "")
        return f"snowflake://{user}:{password}@{account}/{database}?warehouse={warehouse}"
    raise ProfilerError(f"Unsupported adapter: {adapter}")


def _profiled_row_count(profiles: dict[str, dict[str, Any]]) -> int:
    """Return the row count used for column statistics."""
    return max((int(p.get("row_count", 0)) for p in profiles.values()), default=0)


def build_profiling_meta(
    profiles: dict[str, dict[str, Any]],
    *,
    total_row_count: int | None,
    sample_size: int | None,
) -> dict[str, Any]:
    """Build model-level profiling metadata for the frontend."""
    profiled_row_count = _profiled_row_count(profiles)
    total = total_row_count if total_row_count is not None else profiled_row_count
    is_sampled = sample_size is not None and profiled_row_count < total
    return {
        "total_row_count": total,
        "profiled_row_count": profiled_row_count,
        "sample_size": sample_size,
        "is_sampled": is_sampled,
    }


def _fetch_total_row_count(
    conn: Any,
    schema: str,
    table_name: str,
    adapter: str,
) -> int | None:
    """Query the warehouse for the full table row count."""
    from sqlalchemy import text

    count_sql = build_row_count_query(schema, table_name, adapter=adapter)
    try:
        result = conn.execute(text(count_sql))
        row = result.mappings().fetchone()
        if row is None:
            return None
        return int(row.get("_total_row_count", 0))
    except Exception as e:
        logger.debug("Row count query failed for %s.%s: %s", schema, table_name, e)
        return None


def profile_models(
    models: dict[str, dict[str, Any]],
    adapter: str,
    connection_params: dict[str, Any],
    *,
    sample_size: int | None = None,
    cache_dir: Path | None = None,
    use_cache: bool = True,
    top_values_threshold: int = 50,
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, dict[str, Any]]]:
    """Profile all models and return per-model column profiles and metadata.

    Args:
        models: Dict of model_id -> model data dict.
        adapter: Database adapter type (duckdb, postgres, snowflake).
        connection_params: Connection parameters for the adapter.
        sample_size: Max rows to sample per model (None = full table).
        cache_dir: Directory to store/load profile cache.
        use_cache: Whether to use caching.
        top_values_threshold: Max distinct values to collect top_values for.

    Returns:
        Tuple of (column profiles dict, model profiling metadata dict).
        Column profiles map model_id -> column_name -> profile dict.
        Model metadata maps model_id -> profiling meta dict.
    """
    try:
        from sqlalchemy import create_engine, text
    except ImportError as e:
        raise ProfilerError(
            "SQLAlchemy is required for profiling. Install with: pip install docglow[profiling]"
        ) from e

    cache: dict[str, Any] = {}
    if cache_dir and use_cache:
        cache = load_cache(cache_dir)

    url = _get_connection_url(adapter, connection_params)
    engine = create_engine(url)

    all_profiles: dict[str, dict[str, dict[str, Any]]] = {}
    all_model_meta: dict[str, dict[str, Any]] = {}
    profiled_count = 0
    cached_count = 0

    # PII guard: never collect top_values for columns flagged ``meta.pii: true``.
    # Aggregate stats (null_rate, distinct_count, min/max length) are safe, but
    # top_values would embed the actual most-frequent literal values (names,
    # emails, card numbers) into the published bundle JSON — a data leak that
    # front-end masking cannot undo. Suppress at collection time.
    pii_columns: set[tuple[str, str]] = set()
    for model_id, model in models.items():
        for col in model.get("columns", []):
            if isinstance(col, dict) and col.get("meta", {}).get("pii"):
                pii_columns.add((model_id, col["name"]))
    if pii_columns:
        logger.info(
            "PII guard: suppressing top_values for %d column(s) across %d model(s)",
            len(pii_columns),
            len({m for m, _ in pii_columns}),
        )

    try:
        with engine.connect() as conn:
            for model_id, model in models.items():
                columns = model.get("columns", [])
                if not columns:
                    continue

                row_count = None
                catalog_stats = model.get("catalog_stats", {})
                if catalog_stats:
                    row_count = catalog_stats.get("row_count")

                # Check cache
                if use_cache and is_cached(cache, model_id, columns, row_count):
                    cached_profiles = get_cached_profiles(cache, model_id)
                    if cached_profiles is not None:
                        all_profiles[model_id] = cached_profiles
                        cached_meta = get_cached_profiling_meta(cache, model_id)
                        if cached_meta is not None:
                            all_model_meta[model_id] = cached_meta
                        else:
                            all_model_meta[model_id] = build_profiling_meta(
                                cached_profiles,
                                total_row_count=row_count,
                                sample_size=sample_size,
                            )
                        cached_count += 1
                        continue

                schema = model.get("schema", "")
                table_name = model.get("name", "")
                materialization = model.get("materialization", "")

                # Skip ephemeral models — they don't exist as tables
                if materialization == "ephemeral":
                    continue

                column_specs = build_column_specs(columns)

                try:
                    # Postgres: skip manifest columns missing from
                    # information_schema (renamed/dropped columns would
                    # otherwise abort the whole stats query and poison the
                    # transaction).  Run INSIDE the per-model try so a
                    # transient probe failure logs+continues like the stats
                    # path, instead of escaping and killing the whole
                    # profiling pass.
                    if adapter in ("postgres", "postgresql") and schema and table_name:
                        col_result = conn.execute(
                            text(
                                "SELECT column_name FROM information_schema.columns "
                                "WHERE table_schema = :schema AND table_name = :table"
                            ),
                            {"schema": schema, "table": table_name},
                        )
                        existing_cols = {r[0] for r in col_result}
                        column_specs = [c for c in column_specs if c.name in existing_cols]
                        if not column_specs:
                            logger.warning(
                                "No matching columns in %s.%s — skipping", schema, table_name
                            )
                            continue

                    total_row_count = row_count
                    if sample_size is not None or total_row_count is None:
                        fetched_total = _fetch_total_row_count(
                            conn, schema, table_name, adapter
                        )
                        if fetched_total is not None:
                            total_row_count = fetched_total

                    # Build and execute stats query
                    stats_sql = build_stats_query(
                        schema,
                        table_name,
                        column_specs,
                        adapter=adapter,
                        sample_size=sample_size,
                    )

                    logger.debug(
                        "Profiling %s.%s (%d columns)",
                        schema,
                        table_name,
                        len(column_specs),
                    )
                    result = conn.execute(text(stats_sql))
                    row = result.mappings().fetchone()
                    if row is None:
                        logger.warning("No results for %s — skipping", model_id)
                        continue

                    profiles = parse_stats_row(dict(row), column_specs)
                    profiling_meta = build_profiling_meta(
                        profiles,
                        total_row_count=total_row_count,
                        sample_size=sample_size,
                    )

                    # Fetch top values for low-cardinality columns
                    for col_spec in column_specs:
                        col_profile = profiles.get(col_spec.name, {})
                        distinct = col_profile.get("distinct_count", 0)
                        has_low_cardinality = (
                            0 < distinct <= top_values_threshold
                            and col_spec.category in ("string", "numeric", "boolean")
                            and (model_id, col_spec.name) not in pii_columns
                        )
                        if has_low_cardinality:
                            tv_sql = build_top_values_query(
                                schema,
                                table_name,
                                col_spec.name,
                                adapter=adapter,
                                limit=distinct,
                            )
                            try:
                                tv_result = conn.execute(text(tv_sql))
                                tv_rows = [dict(r) for r in tv_result.mappings()]
                                col_profile["top_values"] = parse_top_values_rows(tv_rows)
                            except Exception as e:
                                logger.debug(
                                    "Top values query failed for %s.%s: %s",
                                    table_name,
                                    col_spec.name,
                                    e,
                                )

                        # Fetch histogram for numeric columns
                        if col_spec.category == "numeric":
                            col_min = col_profile.get("min")
                            col_max = col_profile.get("max")
                            if col_min is not None and col_max is not None and col_max > col_min:
                                hist_sql = build_histogram_query(
                                    schema,
                                    table_name,
                                    col_spec.name,
                                    adapter=adapter,
                                )
                                try:
                                    hist_result = conn.execute(text(hist_sql))
                                    hist_rows = [dict(r) for r in hist_result.mappings()]
                                    col_profile["histogram"] = parse_histogram_rows(
                                        hist_rows,
                                        float(col_min),
                                        float(col_max),
                                    )
                                except Exception as e:
                                    logger.debug(
                                        "Histogram query failed for %s.%s: %s",
                                        table_name,
                                        col_spec.name,
                                        e,
                                    )

                        # Fetch temporal distribution for date/timestamp columns and YYYYMMDD integer keys
                        if col_spec.category in ("date", "date_key"):
                            temporal_sql = build_temporal_distribution_query(
                                schema,
                                table_name,
                                col_spec.name,
                                adapter=adapter,
                                is_date_key=col_spec.category == "date_key",
                            )
                            try:
                                temp_result = conn.execute(text(temporal_sql))
                                temp_rows = [dict(r) for r in temp_result.mappings()]
                                col_profile["temporal_distribution"] = [
                                    {
                                        "date": str(r.get("date_day", "")),
                                        "count": int(r.get("record_count", 0)),
                                    }
                                    for r in temp_rows
                                    if r.get("date_day") is not None
                                ]
                            except Exception as e:
                                logger.debug(
                                    "Temporal distribution query failed for %s.%s: %s",
                                    table_name,
                                    col_spec.name,
                                    e,
                                )

                    all_profiles[model_id] = profiles
                    all_model_meta[model_id] = profiling_meta
                    profiled_count += 1

                    # Update cache
                    if cache_dir and use_cache:
                        cache = update_cache(
                            cache,
                            model_id,
                            columns,
                            row_count,
                            profiles,
                            profiling=profiling_meta,
                        )

                except Exception as e:
                    logger.warning("Failed to profile %s: %s", model_id, e)
                    # Postgres aborts the transaction on any error; rollback
                    # before moving to the next model so subsequent queries
                    # don't fail with "current transaction is aborted".
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    continue

    finally:
        engine.dispose()

    # Save cache
    if cache_dir and use_cache and profiled_count > 0:
        save_cache(cache_dir, cache)

    logger.info(
        "Profiling complete: %d profiled, %d cached, %d total",
        profiled_count,
        cached_count,
        profiled_count + cached_count,
    )
    return all_profiles, all_model_meta


def apply_profiles(
    models: dict[str, dict[str, Any]],
    profiles: dict[str, dict[str, dict[str, Any]]],
    *,
    model_meta: dict[str, dict[str, Any]] | None = None,
    sample_size: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Return new models dict with profile data applied to columns.

    Does not mutate the input models dict.
    """
    result: dict[str, dict[str, Any]] = {}
    for model_id, model in models.items():
        model_profiles = profiles.get(model_id, {})
        if not model_profiles:
            result[model_id] = model
            continue

        new_columns = [
            {**col, "profile": model_profiles.get(col["name"])} for col in model.get("columns", [])
        ]
        profiling = (model_meta or {}).get(model_id)
        if profiling is None:
            catalog_stats = model.get("catalog_stats", {})
            catalog_row_count = catalog_stats.get("row_count") if catalog_stats else None
            profiling = build_profiling_meta(
                model_profiles,
                total_row_count=catalog_row_count,
                sample_size=sample_size,
            )
        result[model_id] = {**model, "columns": new_columns, "profiling": profiling}

    return result
