"""Parse compiled SQL to extract column-level lineage using SQLGlot."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from docglow.lineage.sql_ast import expression_sql as _expression_sql

logger = logging.getLogger(__name__)

# Adapter type -> SQLGlot dialect mapping
_DIALECT_MAP: dict[str, str] = {
    "bigquery": "bigquery",
    "snowflake": "snowflake",
    "postgres": "postgres",
    "postgresql": "postgres",
    "redshift": "redshift",
    "duckdb": "duckdb",
    "databricks": "databricks",
    "spark": "spark",
    "trino": "trino",
    "clickhouse": "clickhouse",
    "athena": "presto",
    "sqlserver": "tsql",
    "fabric": "tsql",
    "oracle": "oracle",
    "starburst": "trino",
}


@dataclass(frozen=True)
class ColumnDependency:
    """A single column-level dependency.

    For ``constant`` / ``untraced`` columns there is no upstream table; use empty
    ``source_table`` / ``source_column`` and rely on ``transformation`` (+ optional
    ``expression`` for literals).
    """

    source_table: str  # Table name as parsed from SQL (e.g. "schema.table"); "" if none
    source_column: str  # Column name in the source table; "" if none
    transformation: str  # passthrough|rename|aggregated|derived|constant|untraced|unknown
    expression: str | None = None  # Defining SQL expr for derived/aggregated/constant


def detect_dialect(adapter_type: str | None) -> str | None:
    """Map a dbt adapter type to a SQLGlot dialect string.

    Returns None if the adapter type is unknown, which lets SQLGlot
    attempt auto-detection.
    """
    if adapter_type is None:
        return None
    return _DIALECT_MAP.get(adapter_type.lower())


def parse_column_lineage(
    compiled_sql: str,
    schema: dict[str, dict[str, str]] | None = None,
    dialect: str | None = None,
    known_columns: list[str] | None = None,
) -> dict[str, list[ColumnDependency]]:
    """Parse compiled SQL and extract column-level dependencies.

    Args:
        compiled_sql: The compiled SQL string (Jinja already resolved).
        schema: Optional schema mapping of {table_name: {col_name: col_type}}.
            Required for resolving SELECT * expressions.
        dialect: SQL dialect for parsing (e.g. "snowflake", "bigquery").
        known_columns: Optional list of known output column names (e.g. from
            catalog). Used as fallback when the outermost SELECT uses *.

    Returns:
        Dict mapping output column name -> list of upstream ColumnDependency.
        Returns empty dict if SQL cannot be parsed.
    """
    if not compiled_sql or not compiled_sql.strip():
        return {}

    try:
        import sqlglot
        from sqlglot import exp
    except ImportError:
        logger.warning(
            "sqlglot is not installed. Install with: pip install docglow[column-lineage]"
        )
        return {}

    # Parse the SQL to find output column names
    try:
        parsed = sqlglot.parse(compiled_sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        logger.debug("Failed to parse SQL for column lineage")
        return {}

    if not parsed:
        return {}

    # Get the outermost SELECT statement
    select_stmt = None
    for statement in parsed:
        if statement is None:
            continue
        select_stmt = statement.find(exp.Select)
        if select_stmt:
            break

    if select_stmt is None:
        return {}

    # Extract output column names from the SELECT clause
    output_columns = _extract_output_columns(select_stmt)

    # Check for SELECT * EXCLUDE(...) pattern
    excluded_cols = _get_excluded_columns(select_stmt)

    # Detect if outermost SELECT uses * or * EXCLUDE
    has_star = any(isinstance(expr, exp.Star) for expr in select_stmt.expressions)
    # UNION ALL of SELECT * — also treat as star (first arm already detected).
    if not has_star and parsed[0] is not None and parsed[0].find(exp.Union) is not None:
        has_star = any(
            isinstance(expr, exp.Star)
            for sel in parsed[0].find_all(exp.Select)
            for expr in (sel.expressions or [])
        )

    schema_star = _star_columns_from_schema(parsed[0], schema, excluded_cols) if has_star else []
    star_source = list(known_columns or [])
    # Prefer schema-derived columns when richer (e.g. thin YAML on union_relations).
    if schema_star and len(schema_star) > len(star_source):
        star_source = schema_star

    # If SELECT * (with or without EXCLUDE) and we have known columns, use those
    if has_star and star_source:
        # Start with known columns, remove excluded ones
        star_columns = [c for c in star_source if c.lower() not in excluded_cols]
        # Remove columns that are already explicitly listed (e.g. aliased CASE exprs)
        explicit_names = {c.lower() for c in output_columns}
        star_columns = [c for c in star_columns if c.lower() not in explicit_names]
        # Prepend star columns before explicit columns
        output_columns = star_columns + output_columns
    elif has_star and not star_source:
        # No catalog/manifest columns — try to resolve from the CTE definition
        cte_columns = _resolve_star_from_cte(parsed[0], select_stmt, excluded_cols, dialect)
        if cte_columns:
            explicit_names = {c.lower() for c in output_columns}
            cte_columns = [c for c in cte_columns if c.lower() not in explicit_names]
            output_columns = cte_columns + output_columns
            logger.debug(
                "Resolved %d columns from CTE for SELECT * (no catalog data)",
                len(cte_columns),
            )
    elif not output_columns and known_columns:
        output_columns = list(known_columns)

    if not output_columns:
        return {}

    # If the outermost SELECT uses *, rewrite it to explicit columns
    # so SQLGlot's lineage() can trace through
    trace_sql = compiled_sql
    if has_star and output_columns:
        trace_sql = _rewrite_star_to_columns(compiled_sql, output_columns, dialect)

    # Trace lineage for each output column with a per-column timeout.
    # Reuse a single executor across all columns to avoid the overhead of
    # creating/destroying a ThreadPoolExecutor for every column.
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures import TimeoutError as FuturesTimeout

    result: dict[str, list[ColumnDependency]] = {}
    failures: list[str] = []
    resolved_schema = schema or {}

    with ThreadPoolExecutor(max_workers=1) as executor:
        for col_name in output_columns:
            try:
                deps = _trace_column_in_executor(
                    executor,
                    col_name,
                    trace_sql,
                    resolved_schema,
                    dialect,
                )
                if deps:
                    result[col_name] = deps
            except FuturesTimeout:
                logger.debug("Timeout tracing lineage for column '%s'", col_name)
                failures.append(col_name)
            except Exception as e:  # noqa: BLE001
                logger.debug("Failed to trace lineage for column '%s': %s", col_name, e)
                failures.append(col_name)

    if failures:
        logger.debug(
            "Column lineage: %d/%d columns could not be traced",
            len(failures),
            len(output_columns),
        )

    return result


def _trace_column_in_executor(
    executor: Any,
    col_name: str,
    sql: str,
    schema: dict[str, dict[str, str]],
    dialect: str | None,
    timeout_seconds: int = 2,
) -> list[ColumnDependency]:
    """Trace lineage for a single column using a shared executor for timeout."""
    from concurrent.futures import TimeoutError as FuturesTimeout

    from sqlglot.lineage import lineage

    def _trace() -> list[ColumnDependency]:
        # Try with schema first (enables SELECT * expansion through CTEs).
        # If it fails, retry without schema (handles cases where schema
        # keys don't match SQL table references or columns are missing).
        try:
            node = lineage(
                column=col_name,
                sql=sql,
                schema=schema or {},
                dialect=dialect,
            )
            deps = _collect_dependencies(node, output_column=col_name, dialect=dialect)
            if deps:
                return deps
        except Exception:  # noqa: BLE001
            pass  # Fall through to retry without schema

        # Retry without schema (more lenient — won't resolve SELECT * but
        # won't blow up on unknown columns or variant access syntax)
        try:
            node = lineage(
                column=col_name,
                sql=sql,
                schema={},
                dialect=dialect,
            )
            return _collect_dependencies(node, output_column=col_name, dialect=dialect)
        except Exception:  # noqa: BLE001
            return []

    future = executor.submit(_trace)
    try:
        result: list[ColumnDependency] = future.result(timeout=timeout_seconds)
        return result
    except FuturesTimeout:
        # Best-effort cancel — the thread may still be running since Python
        # threads can't be forcibly interrupted, but this prevents the result
        # from being collected if it finishes later.
        future.cancel()
        raise


def _rewrite_star_to_columns(
    sql: str,
    columns: list[str],
    dialect: str | None,
) -> str:
    """Rewrite the outermost SELECT * to list explicit column names.

    SQLGlot's lineage() cannot trace columns through SELECT * from a CTE.
    By replacing `SELECT * FROM cte` with `SELECT col1, col2 FROM cte`,
    lineage() can resolve each column through the CTE definitions.
    """
    import sqlglot
    from sqlglot import exp

    try:
        parsed = sqlglot.parse(sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        return sql

    if not parsed or parsed[0] is None:
        return sql

    tree = parsed[0]
    outermost = tree.find(exp.Select)
    if outermost is None:
        return sql

    # Only rewrite if the outermost SELECT contains a Star
    has_star = any(isinstance(expr, exp.Star) for expr in outermost.expressions)
    if not has_star:
        return sql

    # Build new column expressions
    new_exprs = [exp.Column(this=exp.to_identifier(c)) for c in columns]
    outermost.set("expressions", new_exprs)

    result: str = tree.sql(dialect=dialect)
    return result


def _extract_output_columns(select: Any) -> list[str]:
    """Extract output column names from a SELECT expression."""
    from sqlglot import exp

    columns: list[str] = []
    for expression in select.expressions:
        if isinstance(expression, exp.Alias):
            columns.append(expression.alias)
        elif isinstance(expression, exp.Column):
            columns.append(expression.name)
        elif isinstance(expression, exp.Star):
            continue
        else:
            alias = expression.alias_or_name
            if alias:
                columns.append(alias)
    return columns


def _star_columns_from_schema(
    tree: Any,
    schema: dict[str, dict[str, str]] | None,
    excluded_cols: set[str],
) -> list[str]:
    """Column names for ``SELECT *`` / ``UNION ALL`` arms from the schema map.

    For multi-arm unions, return the intersection of arm schemas so name-aligned
    ``union_relations`` shells expand to a shared column list.
    """
    if not schema or tree is None:
        return []
    from sqlglot import exp

    per_arm: list[set[str]] = []
    for sel in tree.find_all(exp.Select):
        if not any(isinstance(e, exp.Star) for e in (sel.expressions or [])):
            continue
        arm: set[str] = set()
        for table in sel.find_all(exp.Table):
            name = getattr(table, "name", None) or ""
            if not name:
                continue
            col_map = schema.get(name) or {}
            db = getattr(table, "db", None) or ""
            catalog = getattr(table, "catalog", None) or ""
            if not col_map and db:
                col_map = schema.get(f"{db}.{name}") or {}
            if not col_map and catalog and db:
                col_map = schema.get(f"{catalog}.{db}.{name}") or {}
            for col in col_map:
                if col.lower() not in excluded_cols:
                    arm.add(col)
        if arm:
            per_arm.append(arm)
    if not per_arm:
        return []
    shared = set.intersection(*per_arm) if len(per_arm) > 1 else per_arm[0]
    return sorted(shared)


def _resolve_star_from_cte(
    tree: Any,
    outer_select: Any,
    excluded_cols: set[str],
    dialect: str | None,
) -> list[str]:
    """Resolve column names for SELECT * by inspecting the referenced CTE.

    When the outermost SELECT is ``SELECT * FROM some_cte`` and we have no
    catalog/manifest columns, we can look at the CTE definition to find the
    output column names. This handles the common dbt pattern::

        WITH renamed AS (
            SELECT col_a, col_b AS alias_b, ...
            FROM source
        )
        SELECT * FROM renamed
    """
    from sqlglot import exp

    # Find the FROM clause of the outermost SELECT
    from_clause = outer_select.find(exp.From)
    if not from_clause:
        return []

    # Get the table name referenced in FROM
    table = from_clause.find(exp.Table)
    if not table:
        return []

    cte_name = table.name.lower()

    # Find the matching CTE definition
    for cte in tree.find_all(exp.CTE):
        alias = cte.alias
        if not alias or alias.lower() != cte_name:
            continue

        # Found the CTE — extract its output columns
        cte_select = cte.find(exp.Select)
        if not cte_select:
            return []

        # Check if the CTE itself uses SELECT *
        cte_has_star = any(isinstance(e, exp.Star) for e in cte_select.expressions)
        if cte_has_star:
            # CTE also uses SELECT * — we can't resolve further without schema
            return []

        columns = _extract_output_columns(cte_select)

        # Apply EXCLUDE filter
        if excluded_cols:
            columns = [c for c in columns if c.lower() not in excluded_cols]

        return columns

    return []


def _get_excluded_columns(select: Any) -> set[str]:
    """Extract column names from EXCLUDE/EXCEPT clause in SELECT * EXCLUDE(...)."""
    from sqlglot import exp

    excluded: set[str] = set()
    for expression in select.expressions:
        if isinstance(expression, exp.Star):
            # Star may contain EXCLUDE/EXCEPT columns as children
            for child in expression.walk():
                if isinstance(child, exp.Column):
                    excluded.add(child.name.lower())
    return excluded


def _collect_dependencies(
    root_node: Any,
    output_column: str | None = None,
    dialect: str | None = None,
) -> list[ColumnDependency]:
    """Walk a SQLGlot lineage node tree and collect leaf dependencies.

    The lineage tree has:
    - root_node: the target column (its .expression shows the full expr)
    - downstream nodes: each has .name like "table.column" and .source

    For nodes with Table sources (true leaves), we extract the table and column.
    When a leaf is a '*' (from SELECT *), we look at the parent node for the
    actual column name.

    Transformation is classified across the whole lineage tree (not just the
    outermost SELECT), so CTE-defining expressions like
    ``coalesce(type = 'jaffle', false)`` stay ``derived`` even when the outer
    query is ``SELECT * FROM cte``.

    When the defining expression references more columns than SQLGlot's lineage
    tree exposed as table leaves (common for CASE with same-named output/input),
    missing identifiers are supplemented from the expression SQL.
    """
    from sqlglot import exp

    deps: list[ColumnDependency] = []
    seen: set[tuple[str, str]] = set()

    transformation, expression = _classify_lineage_tree(root_node)

    # Collect all nodes with their parent context
    all_nodes: list[tuple[Any, Any | None]] = []
    _walk_with_parent(root_node, None, all_nodes)

    for lineage_node, parent_node in all_nodes:
        if lineage_node is root_node:
            continue

        node_name = lineage_node.name if isinstance(lineage_node.name, str) else ""
        source_column = _extract_column_from_node_name(node_name)

        if isinstance(lineage_node.source, exp.Table):
            source_table = _table_to_string(lineage_node.source)

            # If the leaf is a '*', use the parent's column name instead
            if source_column == "*" and parent_node is not None:
                parent_name = parent_node.name if isinstance(parent_node.name, str) else ""
                parent_col = _extract_column_from_node_name(parent_name)
                if parent_col and parent_col != "*":
                    source_column = parent_col

            if not source_table or not source_column or source_column == "*":
                continue

            key = (source_table.lower(), source_column.lower())
            if key in seen:
                continue
            seen.add(key)

            dep_transformation = transformation
            if (
                dep_transformation == "passthrough"
                and output_column
                and output_column.lower() != source_column.lower()
            ):
                dep_transformation = "rename"

            deps.append(
                ColumnDependency(
                    source_table=source_table,
                    source_column=source_column,
                    transformation=dep_transformation,
                    expression=(
                        expression
                        if dep_transformation in ("derived", "aggregated", "constant")
                        else None
                    ),
                )
            )

    if not deps:
        # Literal / NULL columns have no table leaves — still emit a constant entry
        # so the UI can show a glyph + formula instead of treating them as missing.
        const_expr = expression
        if transformation != "constant":
            const_expr = _constant_expression_sql(root_node)
            if const_expr is not None:
                transformation = "constant"
        if transformation == "constant":
            return [
                ColumnDependency(
                    source_table="",
                    source_column="",
                    transformation="constant",
                    expression=const_expr or expression,
                )
            ]

    return _supplement_deps_from_expression(deps, dialect=dialect)


def _column_names_from_expression(
    expression: str,
    dialect: str | None = None,
) -> list[str]:
    """Return column identifiers referenced in a SQL expression (stable order)."""
    if not expression or not expression.strip():
        return []

    try:
        import sqlglot
        from sqlglot import exp
    except ImportError:
        return []

    try:
        tree = sqlglot.parse_one(expression, dialect=dialect)
    except Exception:  # noqa: BLE001
        return []

    names: list[str] = []
    seen: set[str] = set()
    for col in tree.find_all(exp.Column):
        name = col.name
        if not isinstance(name, str) or not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def _supplement_deps_from_expression(
    deps: list[ColumnDependency],
    dialect: str | None = None,
) -> list[ColumnDependency]:
    """Add missing expression column refs when SQLGlot lineage omitted them.

    Only runs for single-source derived/aggregated expressions so we do not
    invent cross-table edges. Example: a CASE that flips ``amt_sales_excl_vat``
    using ``transaction_source`` / ``is_item_discount`` should list all three.
    """
    if not deps:
        return deps

    expression = next((d.expression for d in deps if d.expression), None)
    if not expression:
        return deps

    transformation = deps[0].transformation
    if transformation not in ("derived", "aggregated"):
        return deps

    tables = [d.source_table for d in deps if d.source_table]
    unique_tables = list(dict.fromkeys(tables))
    if len(unique_tables) != 1:
        return deps

    source_table = unique_tables[0]
    existing = {
        (d.source_table.lower(), d.source_column.lower())
        for d in deps
        if d.source_table and d.source_column
    }

    out = list(deps)
    for name in _column_names_from_expression(expression, dialect=dialect):
        key = (source_table.lower(), name.lower())
        if key in existing:
            continue
        existing.add(key)
        out.append(
            ColumnDependency(
                source_table=source_table,
                source_column=name,
                transformation=transformation,
                expression=expression,
            )
        )
    return out


def _constant_expression_sql(root_node: Any) -> str | None:
    """If the lineage root is a constant/literal, return its SQL; else None."""
    expr = getattr(root_node, "expression", None)
    if expr is None:
        return None
    if _classify_transformation(expr) != "constant":
        return None
    return _expression_sql(expr)


def _walk_with_parent(node: Any, parent: Any | None, result: list[tuple[Any, Any | None]]) -> None:
    """Walk the lineage tree collecting (node, parent) pairs."""
    result.append((node, parent))
    for child in node.downstream:
        _walk_with_parent(child, node, result)


def _table_to_string(table: Any) -> str:
    """Convert a SQLGlot Table expression to a dotted string."""
    parts: list[str] = []
    if table.catalog:
        parts.append(table.catalog)
    if table.db:
        parts.append(table.db)
    parts.append(table.name)
    return ".".join(parts)


def _extract_column_from_node_name(name: str) -> str:
    """Extract the column name from a lineage node name like 'table.column'."""
    if "." in name:
        return name.rsplit(".", 1)[1]
    return name


# Keep ordered in sync with TRANSFORMATION_STRENGTH in @docglow/shared-types.
_PRIORITY = {
    "unknown": 0,
    "untraced": 0,
    "passthrough": 1,
    "rename": 2,
    "constant": 3,
    "derived": 4,
    "aggregated": 5,
}


def _lineage_has_table_leaf(root_node: Any) -> bool:
    """True when the lineage tree reaches at least one physical table column."""
    from sqlglot import exp

    nodes: list[tuple[Any, Any | None]] = []
    _walk_with_parent(root_node, None, nodes)
    return any(isinstance(node.source, exp.Table) for node, _ in nodes)


def _classify_lineage_tree(root_node: Any) -> tuple[str, str | None]:
    """Classify transformation from the full lineage tree + capture defining SQL.

    Outer ``SELECT * FROM cte`` nodes often look like simple column aliases.
    Walk downstream expressions and keep the strongest classification, along
    with the SQL for the first derived/aggregated/constant defining expression.

    Leaf lineage nodes carry the source ``Table`` as ``expression`` — those are
    not transformations and must be ignored or everything looks ``derived``.

    UNION / sentinel arms often inject literals (e.g. ``'UNKNOWN'``) alongside
    a real column path. When any table leaf exists, ignore constant expressions
    so the sentinel does not override passthrough/rename/derived lineage.
    """
    from sqlglot import exp

    best_kind = "unknown"
    best_priority = -1
    best_expression: str | None = None
    ignore_constants = _lineage_has_table_leaf(root_node)

    def consider(expression: Any) -> None:
        nonlocal best_kind, best_priority, best_expression
        if isinstance(expression, exp.Table):
            return
        kind = _classify_transformation(expression)
        if kind == "constant" and ignore_constants:
            return
        priority = _PRIORITY.get(kind, 0)
        if priority > best_priority:
            best_priority = priority
            best_kind = kind
            if kind in ("derived", "aggregated", "constant"):
                best_expression = _expression_sql(expression)
        elif (
            priority == best_priority
            and kind in ("derived", "aggregated", "constant")
            and best_expression is None
        ):
            best_expression = _expression_sql(expression)

    def walk(node: Any) -> None:
        if getattr(node, "expression", None) is not None:
            consider(node.expression)
        for child in getattr(node, "downstream", []) or []:
            walk(child)

    walk(root_node)
    return best_kind, best_expression


def _classify_transformation(expression: Any) -> str:
    """Classify the transformation type based on a single expression node.

    Returns:
        "passthrough" — column passes through unchanged (SELECT a FROM ...)
        "aggregated" — column is inside an aggregate function (SUM, COUNT, etc.)
        "derived" — column is transformed in some other way (CASE, CONCAT, etc.)
        "constant" — literal / NULL with no column reference
        "unknown" — expression is None (could not be parsed)
    """
    from sqlglot import exp

    if expression is None:
        return "unknown"

    # Unwrap Alias to get the actual expression
    inner = expression
    if isinstance(inner, exp.Alias):
        inner = inner.this

    # Simple column reference — passthrough (rename detection uses output name)
    if isinstance(inner, exp.Column):
        return "passthrough"

    # Literals / NULL (including CAST of a constant)
    if _is_constant_node(inner, exp):
        return "constant"

    # Direct aggregate function
    agg_types = (exp.Sum, exp.Count, exp.Avg, exp.Min, exp.Max, exp.AnyValue)
    if isinstance(inner, agg_types):
        return "aggregated"

    # Check if any descendant is an aggregate (e.g. COALESCE(SUM(x), 0))
    if isinstance(inner, exp.Expression):
        for node in inner.walk():
            if isinstance(node, agg_types):
                return "aggregated"

    return "derived"


def _is_constant_node(node: Any, exp: Any) -> bool:
    """True when ``node`` is a SQL literal/NULL (optionally wrapped in Cast)."""
    if node is None:
        return False
    if isinstance(node, (exp.Null, exp.Literal, exp.Boolean)):
        return True
    if isinstance(node, exp.Cast):
        return _is_constant_node(node.this, exp)
    # Paren / nested wrappers around a constant
    if isinstance(node, exp.Paren):
        return _is_constant_node(node.this, exp)
    return False


def build_schema_mapping(
    models: dict[str, dict[str, Any]],
    sources: dict[str, dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """Build a schema mapping for SQLGlot from docglow model/source data.

    Returns a dict of {table_reference: {column_name: column_type}} that
    SQLGlot can use to expand SELECT * expressions.
    """
    schema: dict[str, dict[str, str]] = {}

    for data in {**models, **sources}.values():
        name = data.get("name", "")
        schema_name = data.get("schema", "")
        database = data.get("database", "")
        if not name:
            continue
        col_map: dict[str, str] = {}
        for col in data.get("columns", []):
            col_type = col.get("data_type", "")
            col_map[col["name"]] = col_type or "VARCHAR"
        if not col_map:
            continue

        # Index by multiple key formats for flexible matching:
        # bare name, schema.name, database.schema.name
        schema.setdefault(name, col_map)
        if schema_name:
            schema[f"{schema_name}.{name}"] = col_map
            if database:
                schema[f"{database}.{schema_name}.{name}"] = col_map

        # Also index by source_name.table_name for sources
        source_name = data.get("source_name", "")
        if source_name:
            schema.setdefault(f"{source_name}.{name}", col_map)

    return schema
