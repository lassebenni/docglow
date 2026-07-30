"""Extract join-key equality pairs from SQL JOIN ON / USING clauses."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UnresolvedJoinKeyPair:
    """A join-key pair before table refs are resolved to dbt unique_ids."""

    left_table: str
    left_column: str
    right_table: str
    right_column: str
    join_type: str | None = None


@dataclass(frozen=True)
class UnresolvedIndirectJoinParent:
    """A parent table reached only through a non-passthrough joined CTE."""

    table: str
    kind: str  # "agg" | "cte"


def extract_join_pairs(
    compiled_sql: str,
    dialect: str | None = None,
) -> list[UnresolvedJoinKeyPair]:
    """Extract bare Column=Column join predicates and USING pairs from SQL.

    Skips CROSS joins, non-equality predicates, and equality sides that are
    expressions (e.g. ``COALESCE(a.id, 0) = b.id``).

    Args:
        compiled_sql: Compiled (or Jinja-stripped) SQL.
        dialect: SQLGlot dialect string.

    Returns:
        List of unresolved join-key pairs. Empty on parse failure.
    """
    if not compiled_sql or not compiled_sql.strip():
        return []

    try:
        import sqlglot
        from sqlglot import exp
    except ImportError:
        return []

    try:
        parsed = sqlglot.parse(compiled_sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        logger.debug("Failed to parse SQL for join-key extraction")
        return []

    if not parsed or parsed[0] is None:
        return []

    tree = parsed[0]
    cte_sources = _build_cte_source_map(tree, exp)
    alias_map = _build_alias_map(tree, exp, cte_sources)
    pairs: list[UnresolvedJoinKeyPair] = []

    for select in tree.find_all(exp.Select):
        from_ = select.args.get("from_")
        if from_ is None:
            continue
        left_expr = from_.this
        joins = select.args.get("joins") or []
        for join in joins:
            join_type = _join_type(join)
            # CROSS / kind=CROSS with no ON/USING → skip
            kind = (join.args.get("kind") or "").upper()
            on_clause = join.args.get("on")
            using = join.args.get("using")

            if kind == "CROSS" and not on_clause and not using:
                left_expr = join.this
                continue

            if using:
                right_ref = _normalize_table_ref(_table_ref(join.this, exp), cte_sources)
                left_ref = (
                    _normalize_table_ref(_table_ref(left_expr, exp), cte_sources)
                    if left_expr is not None
                    else None
                )
                if left_ref and right_ref:
                    for ident in using:
                        col = _ident_name(ident)
                        if col:
                            pairs.append(
                                UnresolvedJoinKeyPair(
                                    left_table=left_ref,
                                    left_column=col,
                                    right_table=right_ref,
                                    right_column=col,
                                    join_type=join_type,
                                )
                            )
            elif on_clause is not None:
                for eq in on_clause.find_all(exp.EQ):
                    pair = _pair_from_eq(eq, alias_map, join_type, exp)
                    if pair is not None:
                        pairs.append(pair)

            left_expr = join.this

    return pairs


def join_key_column_names(pairs: list[UnresolvedJoinKeyPair]) -> set[str]:
    """Return the set of column names appearing in any join pair."""
    names: set[str] = set()
    for p in pairs:
        names.add(p.left_column)
        names.add(p.right_column)
    return names


def extract_join_base_table(
    compiled_sql: str,
    dialect: str | None = None,
) -> str | None:
    """Return the FROM (foundation) table of the model's primary JOIN block.

    Looks for SELECT statements that contain JOINs, picks the one with the
    most JOINs (ties → last in tree order — typically the final ``joined``
    CTE), then resolves the FROM table through simple passthrough CTEs.

    Returns ``None`` when the SQL has no JOINs or cannot be parsed.
    """
    if not compiled_sql or not compiled_sql.strip():
        return None

    try:
        import sqlglot
        from sqlglot import exp
    except ImportError:
        return None

    try:
        parsed = sqlglot.parse(compiled_sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        logger.debug("Failed to parse SQL for join-base extraction")
        return None

    if not parsed or parsed[0] is None:
        return None

    tree = parsed[0]
    cte_sources = _build_cte_source_map(tree, exp)

    best_from: Any | None = None
    best_join_count = 0
    for select in tree.find_all(exp.Select):
        joins = select.args.get("joins") or []
        if not joins:
            continue
        from_ = select.args.get("from_")
        if from_ is None:
            continue
        join_count = len(joins)
        if join_count >= best_join_count:
            best_join_count = join_count
            best_from = from_.this

    if best_from is None:
        return None

    return _normalize_table_ref(_table_ref(best_from, exp), cte_sources)


def extract_indirect_join_parents(
    compiled_sql: str,
    dialect: str | None = None,
) -> list[UnresolvedIndirectJoinParent]:
    """Return parents reached only via non-passthrough CTEs that are JOINed.

    Example: ``stg_supplies`` feeds ``order_supplies_summary`` (aggregate CTE),
    which is then ``LEFT JOIN``ed — so ``stg_supplies`` is neither the FROM base
    nor a direct join endpoint.

    Returns entries with ``kind`` ``agg`` (GROUP BY / aggregate) or ``cte``.
    """
    if not compiled_sql or not compiled_sql.strip():
        return []

    try:
        import sqlglot
        from sqlglot import exp
    except ImportError:
        return []

    try:
        parsed = sqlglot.parse(compiled_sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        logger.debug("Failed to parse SQL for indirect join-parent extraction")
        return []

    if not parsed or parsed[0] is None:
        return []

    tree = parsed[0]
    cte_sources = _build_cte_source_map(tree, exp)
    complex_ctes = _build_complex_cte_map(tree, exp, cte_sources)

    best_joins: list[Any] = []
    best_join_count = 0
    for select in tree.find_all(exp.Select):
        joins = select.args.get("joins") or []
        if not joins:
            continue
        join_count = len(joins)
        if join_count >= best_join_count:
            best_join_count = join_count
            best_joins = list(joins)

    if not best_joins:
        return []

    out: list[UnresolvedIndirectJoinParent] = []
    seen: set[str] = set()
    for join in best_joins:
        joined_ref = _table_ref(join.this, exp)
        if not joined_ref:
            continue
        key = joined_ref.lower()
        short = key.rsplit(".", 1)[-1]
        # Passthrough CTE aliases resolve to direct join endpoints — skip those.
        if key in cte_sources or short in cte_sources:
            continue
        complex = complex_ctes.get(key) or complex_ctes.get(short)
        if complex is None:
            continue

        for table_ref in complex["tables"]:
            marker = table_ref.lower()
            if marker in seen:
                continue
            seen.add(marker)
            out.append(UnresolvedIndirectJoinParent(table=table_ref, kind=complex["kind"]))

    return out


def _build_complex_cte_map(
    tree: Any,
    exp: Any,
    cte_sources: dict[str, str],
) -> dict[str, dict[str, Any]]:
    """Map non-passthrough CTE aliases → underlying tables + kind."""
    complex_ctes: dict[str, dict[str, Any]] = {}

    for cte in tree.find_all(exp.CTE):
        alias = getattr(cte, "alias", None)
        select = cte.this if isinstance(cte.this, exp.Select) else None
        if not alias or select is None:
            continue
        if alias.lower() in cte_sources:
            continue  # simple passthrough

        from_ = select.args.get("from_")
        if from_ is None:
            continue

        tables: list[str] = []
        base_ref = _normalize_table_ref(_table_ref(from_.this, exp), cte_sources)
        if base_ref:
            tables.append(base_ref)
        for join in select.args.get("joins") or []:
            join_ref = _normalize_table_ref(_table_ref(join.this, exp), cte_sources)
            if join_ref:
                tables.append(join_ref)
        if not tables:
            continue

        kind = "agg" if _select_is_aggregate(select, exp) else "cte"
        complex_ctes[alias.lower()] = {"tables": tables, "kind": kind}

    return complex_ctes


def _select_is_aggregate(select: Any, exp: Any) -> bool:
    if select.args.get("group") is not None:
        return True
    for expression in select.expressions or []:
        if expression.find(exp.AggFunc) is not None:
            return True
    return False


def _pair_from_eq(
    eq: Any,
    alias_map: dict[str, str],
    join_type: str | None,
    exp: Any,
) -> UnresolvedJoinKeyPair | None:
    left = eq.left
    right = eq.right
    if not isinstance(left, exp.Column) or not isinstance(right, exp.Column):
        return None

    left_col = left.name
    right_col = right.name
    if not left_col or not right_col:
        return None

    left_table = _resolve_column_table(left, alias_map)
    right_table = _resolve_column_table(right, alias_map)
    if not left_table or not right_table:
        return None

    return UnresolvedJoinKeyPair(
        left_table=left_table,
        left_column=left_col,
        right_table=right_table,
        right_column=right_col,
        join_type=join_type,
    )


def _resolve_column_table(col: Any, alias_map: dict[str, str]) -> str | None:
    """Map a Column's table qualifier to a concrete table reference."""
    table = col.table
    if not table:
        return None
    key = str(table).lower()
    return alias_map.get(key) or str(table)


def _build_alias_map(
    tree: Any,
    exp: Any,
    cte_sources: dict[str, str],
) -> dict[str, str]:
    """Map alias (and bare table name) → table reference string."""
    alias_map: dict[str, str] = {}
    for table in tree.find_all(exp.Table):
        ref = _normalize_table_ref(_table_ref(table, exp), cte_sources)
        if not ref:
            continue
        if table.alias:
            alias_map[table.alias.lower()] = ref
        if table.name:
            alias_map.setdefault(table.name.lower(), ref)
    return alias_map


def _build_cte_source_map(tree: Any, exp: Any) -> dict[str, str]:
    """Map simple passthrough CTE names to their underlying table references."""
    cte_sources: dict[str, str] = {}

    for cte in tree.find_all(exp.CTE):
        alias = getattr(cte, "alias", None)
        select = cte.this if isinstance(cte.this, exp.Select) else None
        if not alias or select is None:
            continue
        if select.args.get("joins"):
            continue
        expressions = select.expressions or []
        if len(expressions) != 1 or not isinstance(expressions[0], exp.Star):
            continue

        from_ = select.args.get("from_")
        if from_ is None:
            continue

        source_ref = _normalize_table_ref(_table_ref(from_.this, exp), cte_sources)
        if source_ref:
            cte_sources[alias.lower()] = source_ref

    return cte_sources


def _normalize_table_ref(
    ref: str | None,
    cte_sources: dict[str, str],
) -> str | None:
    """Collapse simple passthrough CTE refs to their underlying relation."""
    if not ref:
        return None

    seen: set[str] = set()
    current = ref
    while True:
        key = current.lower()
        if key in seen:
            return current
        seen.add(key)
        next_ref = cte_sources.get(key)
        if not next_ref:
            return current
        current = next_ref


def _table_ref(node: Any, exp: Any) -> str | None:
    """Build a schema-qualified table reference from a Table (or nested Join)."""
    # Join.this / From.this may nest; unwrap to Table
    while node is not None and not isinstance(node, exp.Table):
        if isinstance(node, exp.Alias):
            node = node.this
            continue
        if hasattr(node, "this"):
            node = node.this
            continue
        return None

    if node is None or not isinstance(node, exp.Table):
        return None

    parts: list[str] = []
    catalog = node.args.get("catalog")
    db = node.args.get("db")
    if catalog is not None:
        parts.append(str(catalog.name if hasattr(catalog, "name") else catalog))
    if db is not None:
        parts.append(str(db.name if hasattr(db, "name") else db))
    if node.name:
        parts.append(node.name)
    return ".".join(parts) if parts else None


def _ident_name(ident: Any) -> str | None:
    if ident is None:
        return None
    if hasattr(ident, "name") and ident.name:
        return str(ident.name)
    if hasattr(ident, "this"):
        inner = ident.this
        if isinstance(inner, str):
            return inner
        if hasattr(inner, "name"):
            return str(inner.name)
    return str(ident) if ident else None


def _join_type(join: Any) -> str | None:
    side = join.args.get("side")
    kind = join.args.get("kind")
    if side:
        return str(side).lower()
    if kind:
        return str(kind).lower()
    return "inner"
