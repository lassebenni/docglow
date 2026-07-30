"""Shared SQLGlot AST helpers for lineage join-key and CTE graph analysis."""

from __future__ import annotations

from typing import Any


def select_is_aggregate(select: Any, exp: Any) -> bool:
    if select.args.get("group") is not None:
        return True
    for expression in select.expressions or []:
        if expression.find(exp.AggFunc) is not None:
            return True
    return False


def build_cte_source_map(tree: Any, exp: Any) -> dict[str, str]:
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

        source_ref = normalize_table_ref(table_ref(from_.this, exp), cte_sources)
        if source_ref:
            cte_sources[alias.lower()] = source_ref

    return cte_sources


def normalize_table_ref(
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


def table_ref(node: Any, exp: Any) -> str | None:
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


def ident_name(ident: Any) -> str | None:
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


def join_type(join: Any) -> str | None:
    side = join.args.get("side")
    kind = join.args.get("kind")
    if side:
        return str(side).lower()
    if kind:
        return str(kind).lower()
    return "inner"


def expression_sql(expression: Any) -> str | None:
    """Return a compact SQL string for a defining expression (alias stripped)."""
    if expression is None:
        return None
    try:
        from sqlglot import exp
    except ImportError:
        return None

    inner = expression.this if isinstance(expression, exp.Alias) else expression
    try:
        return inner.sql()
    except Exception:  # noqa: BLE001
        return str(inner) if inner is not None else None
