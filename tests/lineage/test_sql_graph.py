"""Tests for intra-model SQL / CTE graph extraction."""

from __future__ import annotations

from docglow.lineage.sql_graph import build_sql_graph
from docglow.lineage.table_resolver import TableResolver

ORDER_ITEMS_SQL = """
with
order_items as (select * from analytics.stg_order_items),
orders as (select * from analytics.stg_orders),
products as (select * from analytics.stg_products),
supplies as (select * from analytics.stg_supplies),
order_supplies_summary as (
    select product_id, sum(supply_cost) as supply_cost
    from supplies
    group by 1
),
joined as (
    select
        order_items.*,
        orders.ordered_at,
        products.product_name,
        order_supplies_summary.supply_cost
    from order_items
    left join orders on order_items.order_id = orders.order_id
    left join products on order_items.product_id = products.product_id
    left join order_supplies_summary
        on order_items.product_id = order_supplies_summary.product_id
)
select * from joined
"""


def _resolver() -> TableResolver:
    return TableResolver(
        models={
            "model.proj.stg_order_items": {"name": "stg_order_items", "schema": "analytics"},
            "model.proj.stg_orders": {"name": "stg_orders", "schema": "analytics"},
            "model.proj.stg_products": {"name": "stg_products", "schema": "analytics"},
            "model.proj.stg_supplies": {"name": "stg_supplies", "schema": "analytics"},
            "model.proj.order_items": {"name": "order_items", "schema": "analytics"},
        },
        sources={},
    )


SCHEMA = {
    "analytics.stg_order_items": {
        "order_item_id": "varchar",
        "order_id": "varchar",
        "product_id": "varchar",
    },
    "analytics.stg_orders": {"order_id": "varchar", "ordered_at": "timestamp"},
    "analytics.stg_products": {"product_id": "varchar", "product_name": "varchar"},
    "analytics.stg_supplies": {
        "product_id": "varchar",
        "supply_cost": "float",
    },
}

OUTPUT_COLS = [
    "order_item_id",
    "order_id",
    "product_id",
    "ordered_at",
    "product_name",
    "supply_cost",
]


class TestBuildSqlGraph:
    def test_order_items_includes_supplies_aggregate_path(self) -> None:
        graph = build_sql_graph(
            ORDER_ITEMS_SQL,
            model_uid="model.proj.order_items",
            model_name="order_items",
            resolver=_resolver(),
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}

        assert "parent:model.proj.stg_supplies" in by_id
        assert "cte:supplies" in by_id
        assert "cte:order_supplies_summary" in by_id
        assert by_id["cte:order_supplies_summary"].get("transforms") == ["aggregate"]

        edge_set = {(e["source"], e["target"]) for e in graph["edges"]}
        assert ("parent:model.proj.stg_supplies", "cte:supplies") in edge_set
        assert ("cte:supplies", "cte:order_supplies_summary") in edge_set

        # Join keys live on join nodes — not duplicated as edge labels
        join_nodes = [n for n in graph["nodes"] if n["kind"] == "join"]
        assert any(
            any(
                k.get("left_column") == "product_id" and k.get("right_column") == "product_id"
                for k in (n.get("join_keys") or [])
            )
            for n in join_nodes
        )
        assert all(
            not e.get("label") for e in graph["edges"] if str(e["source"]).startswith("join:")
        )
        assert any(
            e["target"] == "cte:joined" and e["source"].startswith("join:") for e in graph["edges"]
        )
        assert any(
            e["source"] == "cte:order_supplies_summary" and e["target"].startswith("join:")
            for e in graph["edges"]
        )

        assert ("cte:joined", "output:model.proj.order_items") in edge_set

    def test_empty_without_ctes_or_joins(self) -> None:
        graph = build_sql_graph(
            "select * from analytics.stg_orders",
            model_uid="model.proj.stg_orders",
            model_name="stg_orders",
            resolver=_resolver(),
        )
        assert graph is None

    def test_column_lineage_traces_supply_cost_through_agg(self) -> None:
        graph = build_sql_graph(
            ORDER_ITEMS_SQL,
            model_uid="model.proj.order_items",
            model_name="order_items",
            resolver=_resolver(),
            schema=SCHEMA,
            output_columns=OUTPUT_COLS,
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}

        assert "supply_cost" in (by_id["parent:model.proj.stg_supplies"].get("columns") or [])
        assert "supply_cost" in (by_id["cte:supplies"].get("columns") or [])
        assert "supply_cost" in (by_id["cte:order_supplies_summary"].get("columns") or [])
        assert "supply_cost" in (by_id["cte:joined"].get("columns") or [])
        assert "supply_cost" in (by_id["output:model.proj.order_items"].get("columns") or [])

        cl = graph["column_lineage"]
        agg_deps = cl["cte:order_supplies_summary"]["supply_cost"]
        assert any(
            d["source_node"] == "cte:supplies"
            and d["source_column"] == "supply_cost"
            and d["transformation"] == "aggregated"
            and d.get("expression")
            and "supply_cost" in d["expression"].lower()
            for d in agg_deps
        )
        joined_deps = cl["cte:joined"]["supply_cost"]
        assert any(
            d["source_node"] == "cte:order_supplies_summary" and d["source_column"] == "supply_cost"
            for d in joined_deps
        )

    def test_column_lineage_passthrough_star(self) -> None:
        graph = build_sql_graph(
            ORDER_ITEMS_SQL,
            model_uid="model.proj.order_items",
            model_name="order_items",
            resolver=_resolver(),
            schema=SCHEMA,
            output_columns=OUTPUT_COLS,
        )
        assert graph is not None
        cl = graph["column_lineage"]
        deps = cl["cte:order_items"]["order_id"]
        assert deps[0]["source_node"] == "parent:model.proj.stg_order_items"
        assert deps[0]["transformation"] == "passthrough"

    def test_output_deps_skip_columns_absent_upstream(self) -> None:
        sql = """
        with base as (select order_id from analytics.stg_orders)
        select * from base
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.orders",
            model_name="orders",
            resolver=TableResolver(
                models={
                    "model.proj.stg_orders": {"name": "stg_orders", "schema": "analytics"},
                    "model.proj.orders": {"name": "orders", "schema": "analytics"},
                },
                sources={},
            ),
            schema={"analytics.stg_orders": {"order_id": "varchar", "customer_id": "varchar"}},
            output_columns=["order_id", "customer_id"],
        )
        assert graph is not None
        out = graph["column_lineage"]["output:model.proj.orders"]
        assert "order_id" in out
        assert out["order_id"][0]["source_node"] == "cte:base"
        assert "customer_id" not in out

    def test_derived_expression_captured(self) -> None:
        sql = """
        with
        source as (select * from analytics.stg_products),
        renamed as (
            select
                sku as product_id,
                coalesce(type = 'jaffle', false) as is_food_item
            from source
        )
        select * from renamed
        """
        schema = {
            "analytics.stg_products": {
                "sku": "varchar",
                "type": "varchar",
            }
        }
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.stg_products",
            model_name="stg_products",
            resolver=TableResolver(
                models={
                    "model.proj.stg_products": {"name": "stg_products", "schema": "analytics"},
                },
                sources={},
            ),
            schema=schema,
            output_columns=["product_id", "is_food_item"],
        )
        assert graph is not None
        deps = graph["column_lineage"]["cte:renamed"]["is_food_item"]
        assert deps[0]["transformation"] == "derived"
        assert deps[0].get("expression")
        assert "jaffle" in deps[0]["expression"].lower()
        assert "coalesce" in deps[0]["expression"].lower()

    def test_agg_constant_has_no_phantom_upstream(self) -> None:
        """CAST(0) in an aggregate CTE is constant — not a path into FROM."""
        sql = """
        with
        pos_lines as (
            select document_no, amt_cogs_excl_vat from analytics.fct_lines
        ),
        line_rollup as (
            select
                document_no,
                sum(amt_cogs_excl_vat) as amt_cogs_excl_vat,
                cast(0 as decimal(18, 2)) as amt_employee_discount_excl_vat
            from pos_lines
            group by 1
        )
        select * from line_rollup
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.agg_doc",
            model_name="agg_doc",
            resolver=TableResolver(
                models={
                    "model.proj.fct_lines": {"name": "fct_lines", "schema": "analytics"},
                    "model.proj.agg_doc": {"name": "agg_doc", "schema": "analytics"},
                },
                sources={},
            ),
            schema={
                "analytics.fct_lines": {
                    "document_no": "varchar",
                    "amt_cogs_excl_vat": "decimal",
                },
            },
            output_columns=[
                "document_no",
                "amt_cogs_excl_vat",
                "amt_employee_discount_excl_vat",
            ],
        )
        assert graph is not None
        const_deps = graph["column_lineage"]["cte:line_rollup"]["amt_employee_discount_excl_vat"]
        assert const_deps
        assert all(d["transformation"] == "constant" for d in const_deps)
        assert all(not d.get("source_node") for d in const_deps)
        assert all(not d.get("source_column") for d in const_deps)
        # Real aggregates still point at the upstream column
        cogs = graph["column_lineage"]["cte:line_rollup"]["amt_cogs_excl_vat"]
        assert any(
            d["source_node"] == "cte:pos_lines" and d["source_column"] == "amt_cogs_excl_vat"
            for d in cogs
        )
        # Constant must not be tagged as a group-key in column_agg
        agg_map = next(n for n in graph["nodes"] if n["id"] == "cte:line_rollup").get(
            "column_agg", {}
        )
        assert "amt_employee_discount_excl_vat" not in agg_map
        assert agg_map.get("amt_cogs_excl_vat") == "sum"

    def test_join_alias_resolves_in_column_lineage(self) -> None:
        """COALESCE(sc.col, 'UNKNOWN') must trace to the joined parent, not unresolved:sc."""
        sql = """
        with
        line_rollup as (
            select document_key, sales_channel_key from analytics.fct_lines
        ),
        final as (
            select
                lr.document_key,
                coalesce(sc.sales_channel_code, 'UNKNOWN') as sales_channel_code
            from line_rollup lr
            left join analytics.dim_sales_channel sc
                on lr.sales_channel_key = sc.sales_channel_key
        )
        select * from final
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.agg_by_document",
            model_name="agg_by_document",
            resolver=TableResolver(
                models={
                    "model.proj.fct_lines": {"name": "fct_lines", "schema": "analytics"},
                    "model.proj.dim_sales_channel": {
                        "name": "dim_sales_channel",
                        "schema": "analytics",
                    },
                    "model.proj.agg_by_document": {
                        "name": "agg_by_document",
                        "schema": "analytics",
                    },
                },
                sources={},
            ),
            schema={
                "analytics.fct_lines": {
                    "document_key": "varchar",
                    "sales_channel_key": "varchar",
                },
                "analytics.dim_sales_channel": {
                    "sales_channel_key": "varchar",
                    "sales_channel_code": "varchar",
                },
            },
            output_columns=["document_key", "sales_channel_code"],
        )
        assert graph is not None
        deps = graph["column_lineage"]["cte:final"]["sales_channel_code"]
        assert deps
        assert all(d["transformation"] == "derived" for d in deps)
        assert any(
            d["source_node"] == "parent:model.proj.dim_sales_channel"
            and d["source_column"] == "sales_channel_code"
            for d in deps
        )
        assert not any("unresolved:sc" in d.get("source_node", "") for d in deps)

    def test_cte_ops_filter_only_window_on_column(self) -> None:
        sql = """
        with
        base as (select * from analytics.stg_orders),
        flagged as (
            select
                order_id,
                case when status = 'completed' then 1 else 0 end as is_done
            from base
            where status is not null
        ),
        numbered as (
            select
                *,
                row_number() over (partition by customer_id order by ordered_at) as n
            from flagged
        )
        select * from numbered
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.orders",
            model_name="orders",
            resolver=TableResolver(
                models={
                    "model.proj.stg_orders": {"name": "stg_orders", "schema": "analytics"},
                    "model.proj.orders": {"name": "orders", "schema": "analytics"},
                },
                sources={},
            ),
            schema={
                "analytics.stg_orders": {
                    "order_id": "varchar",
                    "customer_id": "varchar",
                    "status": "varchar",
                    "ordered_at": "timestamp",
                }
            },
            output_columns=["order_id", "is_done", "n"],
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}

        flagged = by_id["cte:flagged"]
        assert any(o["kind"] == "filter" for o in flagged.get("ops") or [])
        assert not any(o["kind"] == "case" for o in flagged.get("ops") or [])
        assert "filter" in (flagged.get("transforms") or [])
        is_done = graph["column_lineage"]["cte:flagged"]["is_done"]
        assert is_done[0].get("expression")
        assert "case" in is_done[0]["expression"].lower()

        numbered = by_id["cte:numbered"]
        assert "window" in (numbered.get("transforms") or [])
        assert not any(o["kind"] == "window" for o in numbered.get("ops") or [])
        n_deps = graph["column_lineage"]["cte:numbered"]["n"]
        cols = {d["source_column"] for d in n_deps}
        assert "customer_id" in cols
        assert "ordered_at" in cols
        assert n_deps[0].get("expression")
        assert "row_number" in n_deps[0]["expression"].lower()

    def test_aggregate_cte_column_agg_and_no_case_ops(self) -> None:
        sql = """
        with
        order_items as (select * from analytics.stg_order_items),
        order_items_summary as (
            select
                order_id,
                sum(supply_cost) as order_cost,
                count(order_item_id) as count_order_items,
                sum(case when is_food_item then 1 else 0 end) as count_food_items
            from order_items
            group by 1
        )
        select * from order_items_summary
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.orders",
            model_name="orders",
            resolver=TableResolver(
                models={
                    "model.proj.stg_order_items": {
                        "name": "stg_order_items",
                        "schema": "analytics",
                    },
                    "model.proj.orders": {"name": "orders", "schema": "analytics"},
                },
                sources={},
            ),
            schema={
                "analytics.stg_order_items": {
                    "order_id": "varchar",
                    "order_item_id": "varchar",
                    "supply_cost": "float",
                    "is_food_item": "boolean",
                }
            },
            output_columns=[
                "order_id",
                "order_cost",
                "count_order_items",
                "count_food_items",
            ],
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}
        summary = by_id["cte:order_items_summary"]
        assert summary.get("transforms") == ["aggregate"]
        assert summary.get("column_agg") == {
            "order_id": "group",
            "order_cost": "sum",
            "count_order_items": "count",
            "count_food_items": "sum",
        }
        assert summary.get("select_sql")
        assert "count_food_items" in summary["select_sql"].lower()
        assert "group by" in summary["select_sql"].lower()
        ops = summary.get("ops") or []
        assert not any(o["kind"] in ("case", "aggregate") for o in ops)
        food_deps = graph["column_lineage"]["cte:order_items_summary"]["count_food_items"]
        assert food_deps[0].get("expression")
        assert "sum" in food_deps[0]["expression"].lower()
        assert "case" in food_deps[0]["expression"].lower()

    def test_passthrough_flag_and_derived_expression(self) -> None:
        sql = """
        with
        base as (select * from analytics.stg_orders),
        flagged as (
            select
                order_id,
                customer_id,
                count_food_items > 0 as is_food_order
            from base
        )
        select * from flagged
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.orders",
            model_name="orders",
            resolver=TableResolver(
                models={
                    "model.proj.stg_orders": {"name": "stg_orders", "schema": "analytics"},
                    "model.proj.orders": {"name": "orders", "schema": "analytics"},
                },
                sources={},
            ),
            schema={
                "analytics.stg_orders": {
                    "order_id": "varchar",
                    "customer_id": "varchar",
                    "count_food_items": "int",
                }
            },
            output_columns=["order_id", "customer_id", "is_food_order"],
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}
        assert by_id["cte:base"].get("passthrough") is True
        assert not by_id["cte:flagged"].get("passthrough")
        assert not any(o["kind"] == "derived" for o in by_id["cte:flagged"].get("ops") or [])
        deps = graph["column_lineage"]["cte:flagged"]["is_food_order"]
        assert deps[0]["transformation"] == "derived"
        assert deps[0].get("expression")
        assert "count_food_items" in deps[0]["expression"].lower()
        assert deps[0]["source_column"] == "count_food_items"

    def test_cte_same_name_as_model_keeps_parent_edge(self) -> None:
        """CTE ``order_items`` selecting from model ``order_items`` must link to parent."""
        sql = """
        with
        order_items as (select * from analytics.order_items),
        order_items_summary as (
            select order_id, sum(supply_cost) as order_cost
            from order_items
            group by 1
        )
        select * from order_items_summary
        """
        graph = build_sql_graph(
            sql,
            model_uid="model.proj.orders",
            model_name="orders",
            resolver=TableResolver(
                models={
                    "model.proj.order_items": {
                        "name": "order_items",
                        "schema": "analytics",
                    },
                    "model.proj.orders": {"name": "orders", "schema": "analytics"},
                },
                sources={},
            ),
            schema={
                "analytics.order_items": {
                    "order_id": "varchar",
                    "supply_cost": "float",
                }
            },
            output_columns=["order_id", "order_cost"],
        )
        assert graph is not None
        by_id = {n["id"]: n for n in graph["nodes"]}
        assert "parent:model.proj.order_items" in by_id
        assert "order_id" in (by_id["parent:model.proj.order_items"].get("columns") or [])
        assert "order_id" in (by_id["cte:order_items"].get("columns") or [])
        edge_set = {(e["source"], e["target"]) for e in graph["edges"]}
        assert ("parent:model.proj.order_items", "cte:order_items") in edge_set
        assert ("cte:order_items", "cte:order_items_summary") in edge_set
