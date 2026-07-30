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

        # Join on product_id into order_supplies_summary
        join_edges = [
            e
            for e in graph["edges"]
            if e.get("label") == "product_id=product_id"
            and e["source"].startswith("join:")
        ]
        assert any(
            e["target"] == "cte:joined"
            and ("cte:order_supplies_summary", e["source"])
            in {(x["source"], x["target"]) for x in graph["edges"]}
            for e in join_edges
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
