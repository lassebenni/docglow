"""Build an intra-model SQL / CTE graph for lineage visualization (v1–v4)."""

from __future__ import annotations

import logging
from typing import Any

from docglow.lineage.column_parser import _expression_sql
from docglow.lineage.join_keys import (
    _build_cte_source_map,
    _ident_name,
    _join_type,
    _normalize_table_ref,
    _select_is_aggregate,
    _table_ref,
)
from docglow.lineage.table_resolver import TableResolver

logger = logging.getLogger(__name__)

_MAX_OPS_PER_CTE = 12

# Normalized agg tags for UI glyphs (SUM / CNT / GRP / …).
_AGG_FN_KEYS = frozenset({"sum", "count", "avg", "min", "max"})


def build_sql_graph(
    compiled_sql: str,
    *,
    model_uid: str,
    model_name: str,
    resolver: TableResolver,
    dialect: str | None = None,
    schema: dict[str, dict[str, str]] | None = None,
    output_columns: list[str] | None = None,
) -> dict[str, Any] | None:
    """Extract a SqlGraph for one model's compiled SQL.

    v1: parent / cte / join / output structure.
    v2: ``columns`` on nodes + ``column_lineage`` for field drill-down.
    v3: ``ops`` on CTE nodes for on-demand expand (where/having).
    v4: ``column_agg`` + ``select_sql`` on aggregate CTEs; no group/case op nodes.
    v5: no window/case/derived op nodes — expressions on column panel + multi-column deps.
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
        logger.debug("Failed to parse SQL for sql_graph extraction")
        return None

    if not parsed or parsed[0] is None:
        return None

    tree = parsed[0]
    ctes = list(tree.find_all(exp.CTE))
    if not ctes:
        has_joins = any(select.args.get("joins") for select in tree.find_all(exp.Select))
        if not has_joins:
            return None

    cte_sources = _build_cte_source_map(tree, exp)
    cte_aliases = {getattr(cte, "alias", "").lower() for cte in ctes if getattr(cte, "alias", None)}
    schema = schema or {}

    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    edge_seen: set[tuple[str, str]] = set()

    def add_node(node: dict[str, Any]) -> None:
        nodes[node["id"]] = node

    def add_edge(source: str, target: str, *, label: str | None = None) -> None:
        key = (source, target)
        if key in edge_seen or source == target:
            return
        if source not in nodes or target not in nodes:
            return
        edge_seen.add(key)
        edge: dict[str, Any] = {"source": source, "target": target}
        if label:
            edge["label"] = label
        edges.append(edge)

    def ensure_parent(table_ref: str) -> str | None:
        uid = resolver.resolve(table_ref)
        if uid:
            node_id = f"parent:{uid}"
            label = uid.rsplit(".", 1)[-1]
            cols = _schema_columns(schema, table_ref, label)
            add_node(
                {
                    "id": node_id,
                    "kind": "parent",
                    "label": label,
                    "model_id": uid,
                    **({"columns": cols} if cols else {}),
                }
            )
            return node_id
        short = table_ref.rsplit(".", 1)[-1]
        node_id = f"parent:unresolved:{table_ref.lower()}"
        cols = _schema_columns(schema, table_ref, short)
        add_node(
            {
                "id": node_id,
                "kind": "parent",
                "label": short,
                **({"columns": cols} if cols else {}),
            }
        )
        return node_id

    def relation_node_id(raw_ref: str | None) -> str | None:
        if not raw_ref:
            return None
        key = raw_ref.lower().replace('"', "")
        short = key.rsplit(".", 1)[-1]
        # Unqualified names that match a CTE alias are CTE refs
        # (``from order_items`` inside another CTE).
        # Qualified names that share a CTE short name are physical tables
        # (``from "db"."schema"."order_items"`` inside CTE order_items itself).
        is_qualified = "." in key
        if short in cte_aliases or key in cte_aliases:
            if not is_qualified:
                alias = short if short in cte_aliases else key
                return f"cte:{alias}"
            # Prefer resolved parent model when the FQ name maps to a dbt node
            if resolver.resolve(raw_ref) or resolver.resolve(key):
                return ensure_parent(raw_ref)
            alias = short if short in cte_aliases else key
            return f"cte:{alias}"
        return ensure_parent(raw_ref)

    # --- CTE nodes + parent/source edges ---------------------------------
    for cte in ctes:
        alias = getattr(cte, "alias", None)
        select = cte.this if isinstance(cte.this, exp.Select) else None
        if not alias or select is None:
            continue
        alias_l = alias.lower()
        cte_id = f"cte:{alias_l}"
        transforms: list[str] = []
        is_agg = _select_is_aggregate(select, exp)
        if is_agg:
            transforms.append("aggregate")
        if _select_has_window(select, exp):
            transforms.append("window")

        # Only WHERE/HAVING as expandable ops — column formulas live on the panel
        ops = _extract_cte_ops(select, exp, cte_id=cte_id)
        for op in ops:
            if op["kind"] == "filter" and "filter" not in transforms:
                transforms.append("filter")

        passthrough = _select_is_passthrough(select, exp)
        column_agg = _column_agg_map(select, exp) if is_agg else None
        select_sql = _select_sql(select) if is_agg else None
        add_node(
            {
                "id": cte_id,
                "kind": "cte",
                "label": alias,
                "cte_name": alias,
                **({"transforms": transforms} if transforms else {}),
                **({"ops": ops} if ops else {}),
                **({"passthrough": True} if passthrough else {}),
                **({"column_agg": column_agg} if column_agg else {}),
                **({"select_sql": select_sql} if select_sql else {}),
            }
        )

        from_ = select.args.get("from_")
        if from_ is None:
            continue

        cte_joins = select.args.get("joins") or []
        if cte_joins:
            continue

        from_raw = _table_ref(from_.this, exp)
        if not from_raw:
            continue
        from_key = from_raw.lower()
        from_short = from_key.rsplit(".", 1)[-1]
        # FROM matching this CTE's own name is the physical table (a CTE cannot
        # select from itself). Matching only *other* CTE aliases avoids dropping
        # the parent edge when CTE and model share a name (e.g. order_items).
        is_other_cte = (
            (from_key in cte_aliases or from_short in cte_aliases)
            and from_short != alias_l
            and from_key != alias_l
        )
        if is_other_cte:
            src = f"cte:{from_short if from_short in cte_aliases else from_key}"
            add_edge(src, cte_id)
        else:
            collapsed = _normalize_table_ref(from_raw, cte_sources)
            parent_id = ensure_parent(collapsed or from_raw)
            if parent_id:
                add_edge(parent_id, cte_id)

    # --- Primary JOIN block → join nodes ---------------------------------
    best_select: Any | None = None
    best_join_count = 0
    for select in tree.find_all(exp.Select):
        joins = select.args.get("joins") or []
        if not joins:
            continue
        if len(joins) >= best_join_count:
            best_join_count = len(joins)
            best_select = select

    join_target_id: str | None = None
    if best_select is not None:
        parent_cte = None
        node = best_select.parent
        while node is not None:
            if isinstance(node, exp.CTE):
                parent_cte = node
                break
            node = getattr(node, "parent", None)
        if parent_cte is not None and getattr(parent_cte, "alias", None):
            join_target_id = f"cte:{parent_cte.alias.lower()}"
        else:
            join_target_id = f"output:{model_uid}"

        from_ = best_select.args.get("from_")
        left_raw = _table_ref(from_.this, exp) if from_ else None
        left_id = relation_node_id(left_raw)

        for idx, join in enumerate(best_select.args.get("joins") or []):
            kind = (join.args.get("kind") or "").upper()
            on_clause = join.args.get("on")
            using = join.args.get("using")
            if kind == "CROSS" and not on_clause and not using:
                right_raw = _table_ref(join.this, exp)
                left_id = relation_node_id(right_raw) or left_id
                continue

            right_raw = _table_ref(join.this, exp)
            right_id = relation_node_id(right_raw)
            jtype = _join_type(join) or "inner"
            join_keys = _join_keys_from_join(join, exp)

            join_id = f"join:{idx}:{jtype}"
            add_node(
                {
                    "id": join_id,
                    "kind": "join",
                    "label": f"{jtype} join",
                    "join_type": jtype,
                    **({"join_keys": join_keys} if join_keys else {}),
                }
            )
            if left_id:
                add_edge(left_id, join_id)
            if right_id:
                add_edge(right_id, join_id)
            if join_target_id:
                # Keys live on the join node — avoid duplicating as edge labels.
                add_edge(join_id, join_target_id)
            left_id = join_id

    # --- Output node -----------------------------------------------------
    output_id = f"output:{model_uid}"
    out_cols = list(output_columns or [])
    add_node(
        {
            "id": output_id,
            "kind": "output",
            "label": model_name,
            "model_id": model_uid,
            **({"columns": out_cols} if out_cols else {}),
        }
    )

    outer = None
    for select in tree.find_all(exp.Select):
        if select.parent is None or isinstance(select.parent, exp.With) or type(select.parent).__name__ == "With":
            outer = select
            break
    if outer is None and tree.find_all(exp.Select):
        outer = next(iter(tree.find_all(exp.Select)), None)

    if outer is not None:
        from_ = outer.args.get("from_")
        if from_ is not None:
            out_raw = _table_ref(from_.this, exp)
            out_src = relation_node_id(out_raw)
            if out_src:
                add_edge(out_src, output_id)

    if not any(e["target"] == output_id for e in edges):
        preferred = None
        for name in ("joined", "final", "result"):
            cid = f"cte:{name}"
            if cid in nodes:
                preferred = cid
                break
        if preferred is None and ctes:
            last = ctes[-1]
            if getattr(last, "alias", None):
                preferred = f"cte:{last.alias.lower()}"
        if preferred:
            add_edge(preferred, output_id)

    if len(nodes) < 2 or not edges:
        return None

    # --- v2: columns + column_lineage ------------------------------------
    column_lineage = _build_column_lineage(
        tree=tree,
        exp=exp,
        nodes=nodes,
        edges=edges,
        relation_node_id=relation_node_id,
        output_id=output_id,
        output_columns=out_cols,
    )

    return {
        "nodes": list(nodes.values()),
        "edges": edges,
        "column_lineage": column_lineage,
    }


def _select_is_passthrough(select: Any, exp: Any) -> bool:
    """True for ``SELECT * FROM x`` with no filter/join/group."""
    if select.args.get("where") or select.args.get("having") or select.args.get("group"):
        return False
    if select.args.get("joins"):
        return False
    exprs = select.expressions or []
    if len(exprs) != 1:
        return False
    only = exprs[0]
    if isinstance(only, exp.Star):
        return True
    if isinstance(only, exp.Column) and only.name == "*":
        return True
    return False


def _select_sql(select: Any) -> str | None:
    """Pretty-ish SELECT text for the side panel."""
    try:
        sql = select.sql(pretty=True)
    except Exception:  # noqa: BLE001
        sql = _expression_sql(select)
    if not sql:
        return None
    return sql.strip()


def _agg_fn_key(agg: Any) -> str:
    key = (getattr(agg, "key", None) or "").lower()
    if key in _AGG_FN_KEYS:
        return key
    try:
        name = (agg.sql_name() or "").lower()
    except Exception:  # noqa: BLE001
        name = ""
    if name in _AGG_FN_KEYS:
        return name
    return key or "sum"


def _column_agg_map(select: Any, exp: Any) -> dict[str, str]:
    """Map output column → agg tag (sum/count/avg/min/max/group)."""
    out: dict[str, str] = {}
    for expression in select.expressions or []:
        out_name: str | None = None
        inner = expression
        if isinstance(expression, exp.Alias):
            out_name = expression.alias
            inner = expression.this
        elif isinstance(expression, exp.Column):
            out_name = expression.name
            inner = expression
        elif hasattr(expression, "alias_or_name") and expression.alias_or_name:
            out_name = expression.alias_or_name

        if not out_name or inner is None:
            continue

        if isinstance(inner, exp.Star):
            continue

        if hasattr(inner, "find"):
            agg = inner.find(exp.AggFunc)
            if agg is not None:
                out[out_name] = _agg_fn_key(agg)
                continue

        # Non-aggregated projection in an aggregate SELECT = group key
        out[out_name] = "group"
    return out


def _select_has_window(select: Any, exp: Any) -> bool:
    """True if any projection contains a window function."""
    for expression in select.expressions or []:
        inner = expression.this if isinstance(expression, exp.Alias) else expression
        if inner is not None and hasattr(inner, "find") and inner.find(exp.Window) is not None:
            return True
    return False


def _extract_cte_ops(select: Any, exp: Any, *, cte_id: str) -> list[dict[str, Any]]:
    """Extract CTE-internal ops for on-demand expand.

    Only WHERE / HAVING become graph op nodes. Window / CASE / derived / agg
    formulas are shown on the column panel via ``expression`` + lineage deps.
    """
    ops: list[dict[str, Any]] = []
    seen_expr: set[str] = set()

    def add(kind: str, label: str, expression: str | None, columns: list[str] | None = None) -> None:
        if len(ops) >= _MAX_OPS_PER_CTE:
            return
        key = f"{kind}:{expression or ''}:{','.join(columns or [])}"
        if key in seen_expr:
            return
        seen_expr.add(key)
        op: dict[str, Any] = {
            "id": f"{cte_id}:op:{len(ops)}",
            "kind": kind,
            "label": label,
        }
        if expression:
            op["expression"] = expression
        if columns:
            op["columns"] = columns
        ops.append(op)

    where = select.args.get("where")
    if where is not None:
        where_expr = where.this if getattr(where, "this", None) is not None else where
        add("filter", "where", _expression_sql(where_expr))

    having = select.args.get("having")
    if having is not None:
        having_expr = having.this if getattr(having, "this", None) is not None else having
        add("filter", "having", _expression_sql(having_expr))

    return ops


def _schema_columns(
    schema: dict[str, dict[str, str]],
    table_ref: str,
    short_name: str,
) -> list[str]:
    if not schema:
        return []
    cleaned = table_ref.lower().replace('"', "")
    short = short_name.lower()
    for key, cols in schema.items():
        kl = key.lower()
        if kl == cleaned or kl.endswith("." + short) or kl == short:
            return list(cols.keys())
    return []


def _build_column_lineage(
    *,
    tree: Any,
    exp: Any,
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    relation_node_id: Any,
    output_id: str,
    output_columns: list[str],
) -> dict[str, dict[str, list[dict[str, str]]]]:
    """Fill node columns and return column_lineage map for field drill-down."""
    column_lineage: dict[str, dict[str, list[dict[str, str]]]] = {}
    cte_list = list(tree.find_all(exp.CTE))

    def node_columns(node_id: str) -> list[str]:
        n = nodes.get(node_id)
        if not n:
            return []
        return list(n.get("columns") or [])

    def set_columns(node_id: str, cols: list[str]) -> None:
        if node_id not in nodes or not cols:
            return
        seen: set[str] = set()
        ordered: list[str] = []
        for c in cols:
            if c and c not in seen:
                seen.add(c)
                ordered.append(c)
        nodes[node_id]["columns"] = ordered

    def add_dep(
        target_node: str,
        target_col: str,
        source_node: str,
        source_col: str,
        transformation: str,
        expression: str | None = None,
    ) -> None:
        if target_node not in column_lineage:
            column_lineage[target_node] = {}
        deps = column_lineage[target_node].setdefault(target_col, [])
        marker = f"{source_node}\0{source_col}\0{transformation}\0{expression or ''}"
        if any(
            f"{d.get('source_node')}\0{d.get('source_column')}\0{d.get('transformation')}\0{d.get('expression') or ''}"
            == marker
            for d in deps
        ):
            return
        entry: dict[str, str] = {
            "source_node": source_node,
            "source_column": source_col,
            "transformation": transformation,
        }
        if expression and transformation in ("derived", "aggregated", "constant"):
            entry["expression"] = expression
        deps.append(entry)

    def resolve_rel(alias_or_ref: str | None) -> str | None:
        if not alias_or_ref:
            return None
        return relation_node_id(alias_or_ref)

    for cte in cte_list:
        alias = getattr(cte, "alias", None)
        select = cte.this if isinstance(cte.this, exp.Select) else None
        if not alias or select is None:
            continue
        cte_id = f"cte:{alias.lower()}"
        if cte_id not in nodes:
            continue

        projections = _project_columns(select, exp)
        out_cols: list[str] = []
        is_agg = _select_is_aggregate(select, exp)

        for proj in projections:
            if proj["kind"] == "star":
                src_rel = proj.get("table")
                src_id = resolve_rel(src_rel) if src_rel else None
                if src_id is None:
                    from_ = select.args.get("from_")
                    from_raw = _table_ref(from_.this, exp) if from_ else None
                    src_id = resolve_rel(from_raw) if from_raw else None
                src_cols = node_columns(src_id) if src_id else []
                for col in src_cols:
                    out_cols.append(col)
                    if src_id:
                        add_dep(cte_id, col, src_id, col, "passthrough")
            elif proj["kind"] == "column":
                out_name = proj["out"]
                src_rel = proj.get("table")
                src_col = proj.get("source_col") or out_name
                src_id = resolve_rel(src_rel) if src_rel else None
                if src_id is None:
                    from_ = select.args.get("from_")
                    from_raw = _table_ref(from_.this, exp) if from_ else None
                    src_id = resolve_rel(from_raw) if from_raw else None
                out_cols.append(out_name)
                if src_id and src_col:
                    xform = "rename" if src_col != out_name else "passthrough"
                    add_dep(cte_id, out_name, src_id, src_col, xform)
            elif proj["kind"] == "expr":
                out_name = proj["out"]
                out_cols.append(out_name)
                expr_sql = proj.get("expression")
                from_ = select.args.get("from_")
                from_raw = _table_ref(from_.this, exp) if from_ else None
                default_src = resolve_rel(from_raw) if from_raw else None
                xform = "aggregated" if is_agg or proj.get("aggregated") else "derived"

                sources = proj.get("sources") or []
                if not sources and proj.get("source_col"):
                    sources = [{"table": proj.get("table"), "column": proj["source_col"]}]

                if proj.get("constant") or not sources:
                    add_dep(
                        cte_id,
                        out_name,
                        default_src or "",
                        "",
                        "constant" if proj.get("constant") else xform,
                        expression=expr_sql,
                    )
                else:
                    for src in sources:
                        src_col = src.get("column")
                        if not src_col:
                            continue
                        src_rel = src.get("table")
                        src_id = resolve_rel(src_rel) if src_rel else None
                        if src_id is None:
                            src_id = default_src
                        if not src_id:
                            continue
                        add_dep(
                            cte_id,
                            out_name,
                            src_id,
                            src_col,
                            xform,
                            expression=expr_sql,
                        )

        set_columns(cte_id, out_cols)

    upstream: str | None = None
    for edge in edges:
        if edge["target"] == output_id and str(edge["source"]).startswith("cte:"):
            upstream = edge["source"]
            break
    if upstream is None:
        for name in ("joined", "final", "result"):
            cid = f"cte:{name}"
            if cid in nodes:
                upstream = cid
                break
    if upstream is None:
        for cte in reversed(cte_list):
            alias = getattr(cte, "alias", None)
            if not alias:
                continue
            cid = f"cte:{alias.lower()}"
            if node_columns(cid):
                upstream = cid
                break

    if upstream and output_id in nodes:
        src_cols = node_columns(upstream)
        cols = output_columns or src_cols
        set_columns(output_id, cols)
        for col in cols:
            if col in src_cols:
                add_dep(output_id, col, upstream, col, "passthrough")

    return column_lineage


def _project_columns(select: Any, exp: Any) -> list[dict[str, Any]]:
    """Parse SELECT projections into star / column / expr descriptors."""
    out: list[dict[str, Any]] = []

    def expr_sources(inner: Any) -> list[dict[str, str | None]]:
        if not hasattr(inner, "find_all"):
            return []
        seen: set[tuple[str | None, str]] = set()
        sources: list[dict[str, str | None]] = []
        for col in inner.find_all(exp.Column):
            name = col.name
            if not name or name == "*":
                continue
            table = col.table or None
            key = (table.lower() if table else None, name.lower())
            if key in seen:
                continue
            seen.add(key)
            sources.append({"table": table, "column": name})
        return sources

    for expression in select.expressions or []:
        # table.*
        if isinstance(expression, exp.Column) and expression.name == "*":
            out.append({"kind": "star", "table": expression.table or None})
            continue
        if isinstance(expression, exp.Star):
            out.append({"kind": "star", "table": None})
            continue

        if isinstance(expression, exp.Alias):
            out_name = expression.alias
            inner = expression.this
            if isinstance(inner, exp.Column):
                out.append(
                    {
                        "kind": "column",
                        "out": out_name or inner.name,
                        "table": inner.table or None,
                        "source_col": inner.name,
                    }
                )
            else:
                sources = expr_sources(inner)
                src = sources[0] if sources else None
                aggregated = inner.find(exp.AggFunc) is not None
                out.append(
                    {
                        "kind": "expr",
                        "out": out_name or ((src or {}).get("column") if src else "expr"),
                        "table": (src or {}).get("table") if src else None,
                        "source_col": (src or {}).get("column") if src else None,
                        "sources": sources,
                        "aggregated": aggregated,
                        "constant": not sources,
                        "expression": _expression_sql(expression),
                    }
                )
            continue

        if isinstance(expression, exp.Column):
            out.append(
                {
                    "kind": "column",
                    "out": expression.name,
                    "table": expression.table or None,
                    "source_col": expression.name,
                }
            )
            continue

        # bare expression without alias
        sources = expr_sources(expression)
        src = sources[0] if sources else None
        aggregated = expression.find(exp.AggFunc) is not None if hasattr(expression, "find") else False
        out.append(
            {
                "kind": "expr",
                "out": (src or {}).get("column")
                if src
                else (expression.alias_or_name if hasattr(expression, "alias_or_name") else "expr"),
                "table": (src or {}).get("table") if src else None,
                "source_col": (src or {}).get("column") if src else None,
                "sources": sources,
                "aggregated": aggregated,
                "constant": not sources,
                "expression": _expression_sql(expression),
            }
        )
    return out


def _join_keys_from_join(join: Any, exp: Any) -> list[dict[str, str]]:
    keys: list[dict[str, str]] = []
    using = join.args.get("using")
    if using:
        for ident in using:
            col = _ident_name(ident)
            if col:
                keys.append({"left_column": col, "right_column": col})
        return keys

    on_clause = join.args.get("on")
    if on_clause is None:
        return keys
    for eq in on_clause.find_all(exp.EQ):
        left = eq.left
        right = eq.right
        if not isinstance(left, exp.Column) or not isinstance(right, exp.Column):
            continue
        if left.name and right.name:
            keys.append({"left_column": left.name, "right_column": right.name})
    return keys
