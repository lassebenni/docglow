"""Build an intra-model SQL / CTE graph for lineage visualization (v1 + v2)."""

from __future__ import annotations

import logging
from typing import Any

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
        key = raw_ref.lower()
        short = key.rsplit(".", 1)[-1]
        if key in cte_aliases or short in cte_aliases:
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
        if _select_is_aggregate(select, exp):
            transforms.append("aggregate")

        add_node(
            {
                "id": cte_id,
                "kind": "cte",
                "label": alias,
                "cte_name": alias,
                **({"transforms": transforms} if transforms else {}),
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
        if from_key in cte_aliases or from_short in cte_aliases:
            src = f"cte:{from_short if from_short in cte_aliases else from_key}"
            add_edge(src, cte_id, label="aggregate" if transforms else None)
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
            key_label = ", ".join(
                f"{k['left_column']}={k['right_column']}" for k in join_keys
            ) or jtype
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
                add_edge(join_id, join_target_id, label=key_label or None)
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
    ) -> None:
        if target_node not in column_lineage:
            column_lineage[target_node] = {}
        deps = column_lineage[target_node].setdefault(target_col, [])
        marker = f"{source_node}\0{source_col}\0{transformation}"
        if any(
            f"{d['source_node']}\0{d['source_column']}\0{d['transformation']}" == marker
            for d in deps
        ):
            return
        deps.append(
            {
                "source_node": source_node,
                "source_column": source_col,
                "transformation": transformation,
            }
        )

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
                src_rel = proj.get("table")
                src_col = proj.get("source_col")
                src_id = resolve_rel(src_rel) if src_rel else None
                if src_id is None:
                    from_ = select.args.get("from_")
                    from_raw = _table_ref(from_.this, exp) if from_ else None
                    src_id = resolve_rel(from_raw) if from_raw else None
                if src_id and src_col:
                    xform = "aggregated" if is_agg or proj.get("aggregated") else "derived"
                    add_dep(cte_id, out_name, src_id, src_col, xform)

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
            if col in src_cols or src_cols:
                add_dep(output_id, col, upstream, col, "passthrough")

    return column_lineage


def _project_columns(select: Any, exp: Any) -> list[dict[str, Any]]:
    """Parse SELECT projections into star / column / expr descriptors."""
    out: list[dict[str, Any]] = []
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
                # expression — try find a source column for lineage
                cols = list(inner.find_all(exp.Column)) if hasattr(inner, "find_all") else []
                src = cols[0] if cols else None
                aggregated = inner.find(exp.AggFunc) is not None
                out.append(
                    {
                        "kind": "expr",
                        "out": out_name or (src.name if src else "expr"),
                        "table": src.table if src else None,
                        "source_col": src.name if src else None,
                        "aggregated": aggregated,
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
        cols = list(expression.find_all(exp.Column)) if hasattr(expression, "find_all") else []
        src = cols[0] if cols else None
        aggregated = expression.find(exp.AggFunc) is not None if hasattr(expression, "find") else False
        out.append(
            {
                "kind": "expr",
                "out": src.name if src else expression.alias_or_name if hasattr(expression, "alias_or_name") else "expr",
                "table": src.table if src else None,
                "source_col": src.name if src else None,
                "aggregated": aggregated,
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
