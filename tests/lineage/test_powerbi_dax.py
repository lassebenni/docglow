"""DAX lineage extraction and the sidecar it feeds.

Skipped without pbi-parsers, which needs Python 3.11+ and ships in the
``powerbi`` extra — Docglow itself still supports 3.10.
"""

from __future__ import annotations

import pytest

from docglow.lineage.powerbi_dax import MIN_PYTHON, ColumnRef, analyze
from docglow.lineage.powerbi_model import build_sidecar
from docglow.lineage.powerbi_tmdl import TmdlMeasure, TmdlModel

pytest.importorskip("pbi_parsers", reason="needs the 'powerbi' extra")
pytestmark = pytest.mark.skipif(
    __import__("sys").version_info < MIN_PYTHON, reason="pbi-parsers needs Python 3.11+"
)


def columns(expression: str) -> set[tuple[str, str]]:
    result = analyze(expression)
    assert result.parse_error is None, result.parse_error
    return {(ref.table, ref.column) for ref in result.columns}


class TestNotOperator:
    """pbi-parsers has no NOT; see docglow.lineage.powerbi_dax_not."""

    def test_unary_not_parses(self) -> None:
        assert analyze("NOT ISBLANK([A])").parse_error is None

    def test_not_in_set_parses(self) -> None:
        assert analyze('NOT dim_code[code] IN {"X"}').parse_error is None

    def test_not_does_not_swallow_the_rest_of_the_expression(self) -> None:
        # The real failure: NOT consumes nothing, the operand is abandoned, and
        # the columns after it vanish with no error raised.
        expression = "IF(NOT ISBLANK([A]), SUM(fct_orders[amount]), 0)"
        assert columns(expression) == {("fct_orders", "amount")}

    def test_patching_twice_is_harmless(self) -> None:
        assert analyze("NOT ISBLANK([A])").parse_error is None
        assert analyze("NOT ISBLANK([B])").parse_error is None


class TestColumnRoles:
    def test_aggregated_column_is_a_dependency(self) -> None:
        assert columns("SUM(fct_orders[amount])") == {("fct_orders", "amount")}

    def test_bare_column_reference_is_a_dependency(self) -> None:
        assert columns("fct_orders[amount]") == {("fct_orders", "amount")}

    def test_filter_argument_is_not_a_dependency(self) -> None:
        expression = "CALCULATE(SUM(fct_orders[amount]), fct_orders[is_service] = TRUE)"
        assert columns(expression) == {("fct_orders", "amount")}
        assert ColumnRef("fct_orders", "is_service") in analyze(expression).filter_columns

    def test_column_read_and_filtered_counts_as_read(self) -> None:
        # First-occurrence-wins would classify this as filter-only and drop a
        # real dependency, purely because FILTER is walked first.
        assert columns("SUMX(FILTER(fct_orders, fct_orders[a] > 0), fct_orders[a])") == {
            ("fct_orders", "a")
        }

    def test_disconnected_helper_table_is_filter_context(self) -> None:
        # Slicer/field-parameter tables are prefixed `_` and have no dbt model.
        expression = "SELECTEDVALUE('_Periode_Filter'[mode_key], \"full\")"
        assert columns(expression) == set()
        assert ColumnRef("_Periode_Filter", "mode_key") in analyze(expression).filter_columns

    def test_dimension_stays_filter_context_under_an_aggregation(self) -> None:
        # MIN(dim_date[date]) is a boundary value, not a source of the number.
        expression = "IF(MIN(dim_date[date]) >= [Start], [Revenue], BLANK())"
        assert columns(expression) == set()
        assert ColumnRef("dim_date", "date") in analyze(expression).filter_columns


class TestComponents:
    def test_direct_references_only(self) -> None:
        assert analyze("[A] + [B]").components == ["A", "B"]

    def test_variables_are_not_components(self) -> None:
        # `[_x]` is what actually exercises the guard — a bare `RETURN _x`
        # never reaches the measure-reference branch at all.
        assert analyze("VAR _x = 1\nRETURN [_x] + [Revenue]").components == ["Revenue"]


class TestSidecar:
    def _model(self, *measures: TmdlMeasure) -> TmdlModel:
        return TmdlModel(measures=list(measures), tables={"fct_orders"})

    def test_columns_of_unknown_tables_are_dropped(self) -> None:
        model = self._model(
            TmdlMeasure(name="Total", expression="SUM(fct_orders[amount])"),
            TmdlMeasure(name="Other", expression="SUM(pbi_local[value])"),
        )
        sidecar = build_sidecar(model, exposure_name="dash", known_models={"fct_orders"})
        fields = {f["name"]: f for f in sidecar["exposures"]["dash"]["fields"]}
        assert fields["Total"]["depends_on"] == [
            {"model": "fct_orders", "column": "amount", "transformation": "aggregated"}
        ]
        assert fields["Other"]["depends_on"] == []

    def test_virtual_table_columns_are_not_components(self) -> None:
        # ADDCOLUMNS(t, "v_cy", ...) is read back as [v_cy], which is spelled
        # exactly like a measure reference. Only the model's measure list can
        # tell them apart; without this, measures gain invented dependencies.
        model = self._model(
            TmdlMeasure(name="Revenue", expression="SUM(fct_orders[amount])"),
            TmdlMeasure(
                name="Table HTML",
                expression='SUMX(ADDCOLUMNS(fct_orders, "v_cy", [Revenue]), [v_cy])',
            ),
        )
        sidecar = build_sidecar(model, exposure_name="dash", known_models={"fct_orders"})
        fields = {f["name"]: f for f in sidecar["exposures"]["dash"]["fields"]}
        assert fields["Table HTML"].get("components") == ["Revenue"]

    def test_unreadable_dax_keeps_the_measure_without_lineage(self) -> None:
        model = self._model(TmdlMeasure(name="Broken", expression="SUM(fct_orders["))
        sidecar = build_sidecar(model, exposure_name="dash", known_models={"fct_orders"})
        field = sidecar["exposures"]["dash"]["fields"][0]
        assert field["name"] == "Broken"
        assert field["depends_on"] == []
        assert field["expression"] == "SUM(fct_orders["

    def test_payload_matches_the_sidecar_schema(self) -> None:
        model = self._model(
            TmdlMeasure(name="Total", expression="SUM(fct_orders[amount])", description="Rev")
        )
        sidecar = build_sidecar(model, exposure_name="dash", known_models={"fct_orders"})
        assert sidecar["version"] == 1
        field = sidecar["exposures"]["dash"]["fields"][0]
        assert field["kind"] == "measure"
        assert field["description"] == "Rev"
