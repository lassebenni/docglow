"""Tests for join-key payload canonicalization (map-only, no edge embedding)."""

from __future__ import annotations

from docglow.generator.data import enrich_lineage_edges_with_join_keys


class TestEnrichLineageEdgesWithJoinKeys:
    def test_noop_does_not_embed_on_edges(self) -> None:
        lineage = {
            "edges": [
                {"source": "model.proj.users", "target": "model.proj.orders"},
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
        assert "join_keys" not in lineage["edges"][0]

    def test_noop_when_no_join_keys(self) -> None:
        lineage = {"edges": [{"source": "a", "target": "b"}]}
        enrich_lineage_edges_with_join_keys(lineage, None)
        assert lineage["edges"] == [{"source": "a", "target": "b"}]
