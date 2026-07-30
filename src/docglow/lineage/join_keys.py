"""Extract join-key equality pairs from SQL JOIN ON / USING clauses."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from docglow.lineage.sql_ast import (
    build_cte_source_map as _build_cte_source_map,
)
from docglow.lineage.sql_ast import (
    ident_name as _ident_name,
)
from docglow.lineage.sql_ast import (
    join_type as _join_type,
)
from docglow.lineage.sql_ast import (
    normalize_table_ref as _normalize_table_ref,
)
from docglow.lineage.sql_ast import (
    select_is_aggregate as _select_is_aggregate,
)
from docglow.lineage.sql_ast import (
    table_ref as _table_ref,
)

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


@dataclass(frozen=True)
class UnresolvedJoinAnalysis:
    """All unresolved join facets from a single SQL parse."""

    pairs: tuple[UnresolvedJoinKeyPair, ...] = ()
    base_table: str | None = None
    indirect: tuple[UnresolvedIndirectJoinParent, ...] = ()


@dataclass(frozen=True)
class ResolvedJoinKeyPair:
    """Join-key pair resolved to dbt unique_ids."""

    left_model: str
    left_column: str
    right_model: str
    right_column: str
    join_type: str | None = None

    def to_dict(self) -> dict[str, str]:
        entry = {
            "left_model": self.left_model,
            "left_column": self.left_column,
            "right_model": self.right_model,
            "right_column": self.right_column,
        }
        if self.join_type:
            entry["join_type"] = self.join_type
        return entry


@dataclass(frozen=True)
class ResolvedIndirectJoinParent:
    """Indirect join parent resolved to a dbt unique_id."""

    model: str
    kind: str

    def to_dict(self) -> dict[str, str]:
        return {"model": self.model, "kind": self.kind}


@dataclass(frozen=True)
class ResolvedJoinAnalysis:
    """Resolved join facets ready for cache / site payload."""

    pairs: tuple[ResolvedJoinKeyPair, ...] = ()
    base_model: str | None = None
    indirect: tuple[ResolvedIndirectJoinParent, ...] = ()


def analyze_joins(
    compiled_sql: str,
    dialect: str | None = None,
) -> UnresolvedJoinAnalysis:
    """Parse SQL once and extract join pairs, FROM base, and indirect parents."""
    tree = _parse_sql_tree(compiled_sql, dialect)
    if tree is None:
        return UnresolvedJoinAnalysis()

    from sqlglot import exp

    cte_sources = _build_cte_source_map(tree, exp)
    alias_map = _build_alias_map(tree, exp, cte_sources)
    pairs = _pairs_from_tree(tree, exp, alias_map, cte_sources)
    primary = _primary_join_block(tree, exp)
    base_table: str | None = None
    indirect: list[UnresolvedIndirectJoinParent] = []
    if primary is not None:
        from_expr, joins = primary
        base_table = _normalize_table_ref(_table_ref(from_expr, exp), cte_sources)
        indirect = _indirect_from_joins(joins, exp, cte_sources, tree)

    return UnresolvedJoinAnalysis(
        pairs=tuple(pairs),
        base_table=base_table,
        indirect=tuple(indirect),
    )


def extract_join_pairs(
    compiled_sql: str,
    dialect: str | None = None,
) -> list[UnresolvedJoinKeyPair]:
    """Extract bare Column=Column join predicates and USING pairs from SQL."""
    return list(analyze_joins(compiled_sql, dialect=dialect).pairs)


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
    """Return the FROM (foundation) table of the model's primary JOIN block."""
    return analyze_joins(compiled_sql, dialect=dialect).base_table


def extract_indirect_join_parents(
    compiled_sql: str,
    dialect: str | None = None,
) -> list[UnresolvedIndirectJoinParent]:
    """Return parents reached only via non-passthrough CTEs that are JOINed."""
    return list(analyze_joins(compiled_sql, dialect=dialect).indirect)


def resolve_join_analysis(
    analysis: UnresolvedJoinAnalysis,
    resolver: Any,
) -> ResolvedJoinAnalysis:
    """Resolve unresolved join analysis to dbt unique_ids."""
    pairs = tuple(resolve_join_key_pairs(list(analysis.pairs), resolver))
    base_model = resolver.resolve(analysis.base_table) if analysis.base_table else None
    indirect = tuple(resolve_indirect_join_parents(list(analysis.indirect), resolver))
    return ResolvedJoinAnalysis(pairs=pairs, base_model=base_model, indirect=indirect)


def resolve_join_key_pairs(
    pairs: list[UnresolvedJoinKeyPair],
    resolver: Any,
) -> list[ResolvedJoinKeyPair]:
    """Resolve unresolved join pairs to dbt unique_ids; drop unresolved sides."""
    resolved: list[ResolvedJoinKeyPair] = []
    for pair in pairs:
        left_uid = resolver.resolve(pair.left_table)
        right_uid = resolver.resolve(pair.right_table)
        if not left_uid or not right_uid:
            continue
        resolved.append(
            ResolvedJoinKeyPair(
                left_model=left_uid,
                left_column=pair.left_column,
                right_model=right_uid,
                right_column=pair.right_column,
                join_type=pair.join_type,
            )
        )
    return resolved


def resolve_indirect_join_parents(
    parents: list[UnresolvedIndirectJoinParent],
    resolver: Any,
) -> list[ResolvedIndirectJoinParent]:
    """Resolve indirect join parents to dbt unique_ids."""
    resolved: list[ResolvedIndirectJoinParent] = []
    seen: set[str] = set()
    for parent in parents:
        uid = resolver.resolve(parent.table)
        if not uid or uid in seen:
            continue
        seen.add(uid)
        resolved.append(ResolvedIndirectJoinParent(model=uid, kind=parent.kind))
    return resolved


def _parse_sql_tree(compiled_sql: str, dialect: str | None) -> Any | None:
    if not compiled_sql or not compiled_sql.strip():
        return None
    try:
        import sqlglot
    except ImportError:
        return None
    try:
        parsed = sqlglot.parse(compiled_sql, dialect=dialect)
    except Exception:  # noqa: BLE001
        logger.debug("Failed to parse SQL for join analysis")
        return None
    if not parsed or parsed[0] is None:
        return None
    return parsed[0]


def _pairs_from_tree(
    tree: Any,
    exp: Any,
    alias_map: dict[str, str],
    cte_sources: dict[str, str],
) -> list[UnresolvedJoinKeyPair]:
    pairs: list[UnresolvedJoinKeyPair] = []
    for select in tree.find_all(exp.Select):
        from_ = select.args.get("from_")
        if from_ is None:
            continue
        left_expr = from_.this
        joins = select.args.get("joins") or []
        for join in joins:
            join_type = _join_type(join)
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


def _primary_join_block(tree: Any, exp: Any) -> tuple[Any, list[Any]] | None:
    """Return (FROM expr, joins) for the SELECT with the most JOINs."""
    best_from: Any | None = None
    best_joins: list[Any] = []
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
            best_joins = list(joins)
    if best_from is None:
        return None
    return best_from, best_joins


def _indirect_from_joins(
    joins: list[Any],
    exp: Any,
    cte_sources: dict[str, str],
    tree: Any,
) -> list[UnresolvedIndirectJoinParent]:
    complex_ctes = _build_complex_cte_map(tree, exp, cte_sources)
    out: list[UnresolvedIndirectJoinParent] = []
    seen: set[str] = set()
    for join in joins:
        joined_ref = _table_ref(join.this, exp)
        if not joined_ref:
            continue
        key = joined_ref.lower()
        short = key.rsplit(".", 1)[-1]
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
