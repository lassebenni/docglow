"""Tests for exposure field lineage ingest and merge."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from docglow.lineage.exposure_field_lineage import (
    _field_expression,
    _strip_formula_narrative,
    apply_exposure_field_lineage,
    collect_mart_model_names,
    load_exposure_field_lineage,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "exposure_field_lineage.json"


def test_collect_mart_model_names() -> None:
    sidecar = load_exposure_field_lineage(FIXTURE)
    assert collect_mart_model_names(sidecar) == {"fct_orders"}


def _base_payload() -> tuple[dict, dict, dict]:
    exposures = {
        "exposure.jaffle.weekly_executive_dashboard": {
            "unique_id": "exposure.jaffle.weekly_executive_dashboard",
            "name": "weekly_executive_dashboard",
            "type": "dashboard",
            "description": "",
            "url": "",
            "label": "Weekly Exec",
            "maturity": "high",
            "depends_on": ["model.jaffle.fct_orders"],
            "owner": {},
            "tags": [],
            "meta": {"powerbi": {"semantic_model_name": "Demo"}},
            "columns": [],
        }
    }
    models = {
        "model.jaffle.fct_orders": {
            "unique_id": "model.jaffle.fct_orders",
            "name": "fct_orders",
            "columns": [
                {"name": "order_id", "description": ""},
                {"name": "amount", "description": ""},
            ],
        }
    }
    return exposures, models, {}


class TestLoadExposureFieldLineage:
    def test_loads_fixture(self) -> None:
        sidecar = load_exposure_field_lineage(FIXTURE)
        assert sidecar["version"] == 1
        assert "weekly_executive_dashboard" in sidecar["exposures"]

    def test_rejects_bad_version(self, tmp_path: Path) -> None:
        path = tmp_path / "bad.json"
        path.write_text(json.dumps({"version": 99, "exposures": {}}), encoding="utf-8")
        with pytest.raises(ValueError, match="unsupported"):
            load_exposure_field_lineage(path)


class TestApplyExposureFieldLineage:
    def test_merges_columns_and_lineage(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = load_exposure_field_lineage(FIXTURE)

        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )

        uid = "exposure.jaffle.weekly_executive_dashboard"
        cols = exposures[uid]["columns"]
        assert [c["name"] for c in cols] == [
            "Total Revenue",
            "Order Count",
            "Revenue + Orders",
        ]
        assert cols[0]["meta"]["kind"] == "measure"

        assert lineage is not None
        assert lineage[uid]["Total Revenue"] == [
            {
                "source_model": "model.jaffle.fct_orders",
                "source_column": "amount",
                "transformation": "aggregated",
                "expression": "SUM(orders[order_total])",
            }
        ]
        # Composite expands to leaf deps from both components; formula on first dep.
        composite_deps = lineage[uid]["Revenue + Orders"]
        assert composite_deps[0]["expression"] == "[Total Revenue] + [Order Count]"
        cols_hit = {(d["source_model"], d["source_column"]) for d in composite_deps}
        assert cols_hit == {
            ("model.jaffle.fct_orders", "amount"),
            ("model.jaffle.fct_orders", "order_id"),
        }

    def test_preserves_existing_column_lineage(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = load_exposure_field_lineage(FIXTURE)
        existing = {
            "model.jaffle.fct_orders": {
                "amount": [
                    {
                        "source_model": "model.jaffle.stg_orders",
                        "source_column": "amount",
                        "transformation": "passthrough",
                    }
                ]
            }
        }

        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage=existing,
        )

        assert lineage is not None
        assert "model.jaffle.fct_orders" in lineage
        assert "exposure.jaffle.weekly_executive_dashboard" in lineage

    def test_unknown_exposure_skipped(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "missing_dashboard": {
                    "fields": [
                        {
                            "name": "X",
                            "kind": "measure",
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "amount",
                                    "transformation": "aggregated",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert exposures["exposure.jaffle.weekly_executive_dashboard"]["columns"] == []
        assert lineage == {}

    def test_expression_column_splits_tokens(self) -> None:
        exposures, models, _ = _base_payload()
        models["model.jaffle.fct_orders"]["columns"].append({"name": "discount", "description": ""})
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "Net",
                            "kind": "measure",
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "amount - discount",
                                    "transformation": "derived",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        deps = lineage["exposure.jaffle.weekly_executive_dashboard"]["Net"]
        assert {d["source_column"] for d in deps} == {"amount", "discount"}
        assert all(d["transformation"] == "derived" for d in deps)

    def test_cyclic_components_do_not_hang(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "A",
                            "kind": "measure",
                            "depends_on": [],
                            "components": ["B"],
                        },
                        {
                            "name": "B",
                            "kind": "measure",
                            "depends_on": [],
                            "components": ["A"],
                        },
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        # No leaf deps — cycle yields empty lists (fields still attached as columns).
        uid = "exposure.jaffle.weekly_executive_dashboard"
        assert [c["name"] for c in exposures[uid]["columns"]] == ["A", "B"]
        assert uid not in lineage or "A" not in lineage.get(uid, {})

    def test_rename_transformation_accepted(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "Renamed Amt",
                            "kind": "measure",
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "amount",
                                    "transformation": "rename",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        deps = lineage["exposure.jaffle.weekly_executive_dashboard"]["Renamed Amt"]
        assert deps[0]["transformation"] == "rename"

    def test_renamed_alias_maps_to_rename(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "Alias Amt",
                            "kind": "measure",
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "amount",
                                    "transformation": "renamed",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        deps = lineage["exposure.jaffle.weekly_executive_dashboard"]["Alias Amt"]
        assert deps[0]["transformation"] == "rename"

    def test_case_expression_skips_sql_keywords(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "Conditional",
                            "kind": "measure",
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "case when status = 'x' then amount end",
                                    "transformation": "derived",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        cols = {
            d["source_column"]
            for d in lineage["exposure.jaffle.weekly_executive_dashboard"]["Conditional"]
        }
        assert "amount" in cols
        assert "status" in cols
        assert "case" not in cols
        assert "when" not in cols
        assert "then" not in cols
        assert "end" not in cols


class TestFormulaNarrativeStripping:
    def test_strips_sourced_from_tail(self) -> None:
        raw = """Brutowinst excl. BTW = SUM(amt_sales_excl_vat) − SUM(amt_cogs_excl_vat)

where amt_cogs_excl_vat is sourced from
  XPRT Value Entry → Cost Amount (Actual)
joined per (Document Type, Document No_, Line No_)."""
        assert _strip_formula_narrative(raw) == (
            "Brutowinst excl. BTW = SUM(amt_sales_excl_vat) − SUM(amt_cogs_excl_vat)"
        )

    def test_strips_waarbij_section(self) -> None:
        raw = """Brutomarge % = Brutowinst excl. BTW / Artikelverkoopomzet excl. BTW

waarbij:
  Brutowinst excl. BTW = SUM(amt_sales_excl_vat − amt_cogs_excl_vat)"""
        assert _strip_formula_narrative(raw) == (
            "Brutomarge % = Brutowinst excl. BTW / Artikelverkoopomzet excl. BTW"
        )

    def test_keeps_multiline_dax_and_filter_hints(self) -> None:
        raw = """Bonkortingsbedrag = SUM(amt_discount_excl_vat)
                   filtered: is_txn_discount = TRUE"""
        assert _strip_formula_narrative(raw) == raw

        dax = """Waardebonomzet facturen excl. BTW
  = CALCULATE(
      SUM(fct_sales_txn_line[amt_sales_excl_vat]),
      fct_sales_txn_line[is_voucher] = TRUE
    )"""
        assert _strip_formula_narrative(dax) == dax

    def test_field_expression_applies_strip_to_formula_md(self) -> None:
        assert _field_expression(
            {
                "formula_md": (
                    "Brutowinst excl. BTW = SUM(amt_sales_excl_vat)\n\n"
                    "where amt_cogs_excl_vat is sourced from XPRT."
                )
            }
        ) == "Brutowinst excl. BTW = SUM(amt_sales_excl_vat)"

    def test_merge_attaches_stripped_formula(self) -> None:
        exposures, models, _ = _base_payload()
        sidecar = {
            "version": 1,
            "exposures": {
                "weekly_executive_dashboard": {
                    "fields": [
                        {
                            "name": "Gross Profit",
                            "kind": "measure",
                            "formula_md": (
                                "Gross Profit = SUM(revenue) - SUM(cogs)\n\n"
                                "where cogs is sourced from ledger."
                            ),
                            "depends_on": [
                                {
                                    "model": "fct_orders",
                                    "column": "amount",
                                    "transformation": "aggregated",
                                }
                            ],
                        }
                    ]
                }
            },
        }
        lineage = apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        assert lineage is not None
        deps = lineage["exposure.jaffle.weekly_executive_dashboard"]["Gross Profit"]
        assert deps[0]["expression"] == "Gross Profit = SUM(revenue) - SUM(cogs)"


class TestSearchIndexExposureFields:
    def test_exposure_fields_indexed(self) -> None:
        from docglow.generator.search_index import build_search_index

        exposures, models, _ = _base_payload()
        sidecar = load_exposure_field_lineage(FIXTURE)
        apply_exposure_field_lineage(
            sidecar=sidecar,
            exposures=exposures,
            models=models,
            seeds={},
            snapshots={},
            sources={},
            column_lineage={},
        )
        index = build_search_index(models, {}, {}, {}, exposures=exposures)
        measure_entries = [
            e
            for e in index
            if e["resource_type"] == "column" and e["column_name"] == "Total Revenue"
        ]
        assert len(measure_entries) == 1
        assert measure_entries[0]["unique_id"] == "exposure.jaffle.weekly_executive_dashboard"
