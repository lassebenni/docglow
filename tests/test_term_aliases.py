"""Tests for Dutch/English term alias search enrichment."""

from __future__ import annotations

from pathlib import Path

import yaml

from docglow.generator.term_aliases import (
    TermAliasIndex,
    enrich_search_entries,
    load_term_alias_index,
)


def _write_aliases(path: Path) -> None:
    payload = {
        "bc_tables": {
            "turnover_entry": {
                "bc_name": "Turnover Entry",
                "dutch_primary": "Omzetposten",
                "dutch_aliases": ["omzetpost", "omzetregels"],
                "english_aliases": ["turnover entry"],
                "abbreviations": ["TE"],
                "dbt": {
                    "source": "turnover_entry",
                    "model": "stg_xprt__turnover_entry",
                },
            },
            "sales_cr_memo_line": {
                "dutch_primary": "Creditnotaregels",
                "dutch_aliases": ["retourfactuur"],
                "dbt": {
                    "source": "sales_cr_memo_line",
                    "model": "stg_xprt__sales_cr_memo_line",
                },
            },
        },
        "concepts": {
            "omzet": {
                "english": "revenue",
                "dutch_primary": "Omzet",
                "dutch_aliases": ["verkoopomzet", "netto omzet"],
                "related_tables": ["turnover_entry"],
            },
            "tegoedbon": {
                "english": "gift card / voucher",
                "dutch_primary": "Waardecheque",
                "dutch_aliases": ["tegoedbon", "cadeaubon", "waardebon"],
                "related_tables": ["turnover_entry"],
            },
        },
    }
    path.write_text(yaml.dump(payload), encoding="utf-8")


class TestTermAliasIndex:
    def test_loads_yaml_and_maps_model_names(self, tmp_path: Path) -> None:
        alias_path = tmp_path / "bc_term_aliases.yaml"
        _write_aliases(alias_path)
        index = load_term_alias_index(alias_path)
        assert index is not None
        aliases = index.aliases_for_name("stg_xprt__turnover_entry")
        assert "omzet" in aliases.lower()
        assert "omzetposten" in aliases.lower()
        assert "waardebon" in aliases.lower()

    def test_retouren_maps_to_credit_memo_models(self, tmp_path: Path) -> None:
        alias_path = tmp_path / "bc_term_aliases.yaml"
        _write_aliases(alias_path)
        index = load_term_alias_index(alias_path)
        assert index is not None
        aliases = index.aliases_for_name("stg_xprt__sales_cr_memo_line")
        assert "retouren" in aliases.lower()
        assert "creditnota" in aliases.lower()

    def test_enrich_search_entries_adds_aliases_field(self, tmp_path: Path) -> None:
        alias_path = tmp_path / "bc_term_aliases.yaml"
        _write_aliases(alias_path)
        index = load_term_alias_index(alias_path)
        entries = [
            {
                "id": "model.vt.stg_xprt__turnover_entry",
                "unique_id": "model.vt.stg_xprt__turnover_entry",
                "name": "stg_xprt__turnover_entry",
                "resource_type": "model",
                "description": "",
            }
        ]
        enriched = enrich_search_entries(entries, index)
        assert "aliases" in enriched[0]
        assert "omzet" in enriched[0]["aliases"]

    def test_column_entries_inherit_parent_model_aliases(self) -> None:
        index = TermAliasIndex(
            by_model={"stg_xprt__turnover_entry": {"omzet", "omzetposten"}},
        )
        entries = [
            {
                "id": "model.vt.stg_xprt__turnover_entry::amount",
                "unique_id": "model.vt.stg_xprt__turnover_entry",
                "name": "amount",
                "resource_type": "column",
                "column_name": "amount",
                "model_name": "stg_xprt__turnover_entry",
                "description": "",
            }
        ]
        enriched = enrich_search_entries(entries, index)
        assert "omzet" in enriched[0]["aliases"]
