"""Tests for enriching lineage edges with join keys."""

from __future__ import annotations

from docglow.generator.data import enrich_lineage_edges_with_join_keys


class TestEnrichLineageEdgesWithJoinKeys:
    def test_attaches_oriented_keys_to_matching_edge(self) -> None:
        lineage = {
            "edges": [
                {"source": "model.proj.users", "target": "model.proj.orders"},
                {"source": "model.proj.products", "target": "model.proj.orders"},
            ]
        }
        join_keys = {
            "model.proj.orders": [
                {
                    "left_model": "model.proj.orders",
                    "left_column": "user_id",
                    "right_model": "model.proj.users",
                    "right_column": "id",
                    "join_type": "left",
                }
            ]
        }
        enrich_lineage_edges_with_join_keys(lineage, join_keys)
        users_edge = next(e for e in lineage["edges"] if e["source"] == "model.proj.users")
        assert users_edge["join_keys"] == [{"source_column": "id", "target_column": "user_id"}]
        products_edge = next(e for e in lineage["edges"] if e["source"] == "model.proj.products")
        assert "join_keys" not in products_edge

    def test_sibling_pairs_not_forced_onto_unrelated_edges(self) -> None:
        lineage = {
            "edges": [
                {"source": "model.proj.dim_sku", "target": "model.proj.fact"},
                {"source": "model.proj.dim_size", "target": "model.proj.fact"},
            ]
        }
        join_keys = {
            "model.proj.fact": [
                {
                    "left_model": "model.proj.dim_sku",
                    "left_column": "size_code",
                    "right_model": "model.proj.dim_size",
                    "right_column": "size_code",
                }
            ]
        }
        enrich_lineage_edges_with_join_keys(lineage, join_keys)
        # No depends_on edge between the two dims — edges stay unmodified.
        assert all("join_keys" not in e for e in lineage["edges"])

    def test_noop_when_no_join_keys(self) -> None:
        lineage = {"edges": [{"source": "a", "target": "b"}]}
        enrich_lineage_edges_with_join_keys(lineage, None)
        assert lineage["edges"] == [{"source": "a", "target": "b"}]
