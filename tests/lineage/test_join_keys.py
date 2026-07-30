"""Tests for join-key extraction from SQL JOIN ON / USING clauses."""

from __future__ import annotations

from pathlib import Path

from docglow.lineage.analyzer import resolve_join_key_pairs
from docglow.lineage.join_keys import extract_join_pairs, join_key_column_names
from docglow.lineage.table_resolver import TableResolver


class TestExtractJoinPairs:
    def test_dual_key_and_on(self) -> None:
        sql = """
        select *
        from dim_sku a
        left join dim_item_size b
          on a.item_size_code = b.item_size_code
         and a.item_size_group_code = b.item_size_group_code
        """
        pairs = extract_join_pairs(sql)
        assert len(pairs) == 2
        cols = {(p.left_column, p.right_column) for p in pairs}
        assert ("item_size_code", "item_size_code") in cols
        assert ("item_size_group_code", "item_size_group_code") in cols
        assert all(p.join_type == "left" for p in pairs)

    def test_using_clause(self) -> None:
        sql = "select * from orders a join products p using (product_id)"
        pairs = extract_join_pairs(sql)
        assert len(pairs) == 1
        assert pairs[0].left_column == "product_id"
        assert pairs[0].right_column == "product_id"
        assert pairs[0].left_table == "orders"
        assert pairs[0].right_table == "products"

    def test_cross_join_empty(self) -> None:
        sql = "select * from orders a cross join dims d"
        assert extract_join_pairs(sql) == []

    def test_expression_eq_skipped(self) -> None:
        sql = "select * from orders a join weird w on coalesce(a.id, 0) = w.id"
        assert extract_join_pairs(sql) == []

    def test_alias_resolution_in_tables(self) -> None:
        sql = "select * from analytics.stg_orders o join analytics.stg_users u on o.user_id = u.id"
        pairs = extract_join_pairs(sql)
        assert len(pairs) == 1
        assert pairs[0].left_table == "analytics.stg_orders"
        assert pairs[0].right_table == "analytics.stg_users"
        assert pairs[0].left_column == "user_id"
        assert pairs[0].right_column == "id"

    def test_passthrough_ctes_resolve_to_underlying_relations(self) -> None:
        sql = """
        with
        order_items as (select * from analytics.stg_order_items),
        orders as (select * from analytics.stg_orders),
        products as (select * from analytics.stg_products),
        joined as (
            select order_items.*, orders.ordered_at
            from order_items
            left join orders on order_items.order_id = orders.order_id
            left join products on order_items.product_id = products.product_id
        )
        select * from joined
        """
        pairs = extract_join_pairs(sql)
        refs = {(p.left_table, p.left_column, p.right_table, p.right_column) for p in pairs}
        assert (
            "analytics.stg_order_items",
            "order_id",
            "analytics.stg_orders",
            "order_id",
        ) in refs
        assert (
            "analytics.stg_order_items",
            "product_id",
            "analytics.stg_products",
            "product_id",
        ) in refs

    def test_join_base_is_from_parent_after_cte_collapse(self) -> None:
        from docglow.lineage.join_keys import extract_join_base_table

        sql = """
        with
        order_items as (select * from analytics.stg_order_items),
        orders as (select * from analytics.stg_orders),
        joined as (
            select *
            from order_items
            left join orders on order_items.order_id = orders.order_id
        )
        select * from joined
        """
        assert extract_join_base_table(sql) == "analytics.stg_order_items"

    def test_join_base_none_without_joins(self) -> None:
        from docglow.lineage.join_keys import extract_join_base_table

        assert extract_join_base_table("select * from analytics.stg_orders") is None

    def test_indirect_agg_parent_via_summary_cte(self) -> None:
        from docglow.lineage.join_keys import extract_indirect_join_parents

        sql = """
        with
        order_items as (select * from analytics.stg_order_items),
        orders as (select * from analytics.stg_orders),
        supplies as (select * from analytics.stg_supplies),
        order_supplies_summary as (
            select product_id, sum(supply_cost) as supply_cost
            from supplies
            group by 1
        ),
        joined as (
            select *
            from order_items
            left join orders on order_items.order_id = orders.order_id
            left join order_supplies_summary
                on order_items.product_id = order_supplies_summary.product_id
        )
        select * from joined
        """
        parents = extract_indirect_join_parents(sql)
        assert len(parents) == 1
        assert parents[0].table == "analytics.stg_supplies"
        assert parents[0].kind == "agg"

    def test_join_key_column_names(self) -> None:
        sql = "select * from a join b on a.x = b.y and a.z = b.w"
        names = join_key_column_names(extract_join_pairs(sql))
        assert names == {"x", "y", "z", "w"}

    def test_empty_sql(self) -> None:
        assert extract_join_pairs("") == []
        assert extract_join_pairs("  ") == []


class TestResolveJoinKeyPairs:
    def test_resolves_and_drops_unresolved(self) -> None:
        resolver = TableResolver(
            models={
                "model.proj.orders": {"name": "orders", "schema": "analytics"},
                "model.proj.users": {"name": "users", "schema": "analytics"},
            },
            sources={},
        )
        pairs = extract_join_pairs(
            "select * from analytics.orders o join analytics.users u on o.user_id = u.id"
        )
        resolved = resolve_join_key_pairs(pairs, resolver)
        assert len(resolved) == 1
        assert resolved[0]["left_model"] == "model.proj.orders"
        assert resolved[0]["right_model"] == "model.proj.users"
        assert resolved[0]["left_column"] == "user_id"
        assert resolved[0]["right_column"] == "id"

    def test_drops_unresolved_sides(self) -> None:
        resolver = TableResolver(
            models={"model.proj.orders": {"name": "orders", "schema": "analytics"}},
            sources={},
        )
        pairs = extract_join_pairs(
            "select * from analytics.orders o join analytics.unknown u on o.user_id = u.id"
        )
        assert resolve_join_key_pairs(pairs, resolver) == []


class TestJoinKeysCacheRoundTrip:
    def test_join_keys_survive_cache(self, tmp_path: Path) -> None:
        from docglow.lineage.analyzer import analyze_column_lineage

        models = {
            "model.proj.orders": {
                "name": "orders",
                "schema": "analytics",
                "compiled_sql": (
                    "select o.id, u.name from analytics.raw_orders o "
                    "join analytics.raw_users u on o.user_id = u.id"
                ),
                "columns": [{"name": "id"}, {"name": "name"}],
                "depends_on": [],
            },
        }
        sources = {
            "source.proj.raw.raw_orders": {
                "name": "raw_orders",
                "source_name": "raw",
                "schema": "analytics",
                "columns": [{"name": "id"}, {"name": "user_id"}],
            },
            "source.proj.raw.raw_users": {
                "name": "raw_users",
                "source_name": "raw",
                "schema": "analytics",
                "columns": [{"name": "id"}, {"name": "name"}],
            },
        }
        cache_path = tmp_path / "cache.json"

        class _Rel:
            def __init__(self, name: str) -> None:
                self.relation_name = f'"analytics"."{name}"'

        first = analyze_column_lineage(
            models=models,
            sources=sources,
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={
                "source.proj.raw.raw_orders": _Rel("raw_orders"),
                "source.proj.raw.raw_users": _Rel("raw_users"),
            },
            cache_path=cache_path,
            max_workers=1,
        )
        assert "model.proj.orders" in first.join_keys
        assert len(first.join_keys["model.proj.orders"]) >= 1

        second = analyze_column_lineage(
            models=models,
            sources=sources,
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={
                "source.proj.raw.raw_orders": _Rel("raw_orders"),
                "source.proj.raw.raw_users": _Rel("raw_users"),
            },
            cache_path=cache_path,
            max_workers=1,
        )
        assert first.join_keys == second.join_keys
