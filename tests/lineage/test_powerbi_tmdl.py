"""TMDL reading — no DAX parser needed, so these run on every supported Python."""

from __future__ import annotations

import textwrap

import pytest

from docglow.lineage.powerbi_tmdl import (
    find_model_directory,
    parse_tmdl_file,
    read_model,
)


def tmdl(body: str) -> str:
    """Real TMDL indents with tabs; the fixtures must too or the tests lie."""
    return textwrap.dedent(body).replace("    ", "\t")


class TestExpressionForms:
    def test_inline_expression(self) -> None:
        measures, table = parse_tmdl_file(
            tmdl("""\
            table _Measures
                measure 'Total' = SUM(fct_orders[amount])
                    formatString: #,0
            """)
        )
        assert table == "_Measures"
        assert [m.name for m in measures] == ["Total"]
        assert measures[0].expression == "SUM(fct_orders[amount])"

    def test_indented_block_expression(self) -> None:
        # The block sits *deeper* than the measure keyword; the property lines
        # sit between the two. Getting the indent units wrong here silently
        # yields an empty expression rather than an error.
        measures, _ = parse_tmdl_file(
            tmdl("""\
            table _Measures
                measure Discount =
                        CALCULATE(
                            SUM(fct_orders[discount]),
                            LEFT(dim_code[code], 4) = "SALE"
                        )
                    formatString: #,0
                    displayFolder: 01. Revenue
            """)
        )
        assert len(measures) == 1
        assert measures[0].expression.startswith("CALCULATE(")
        assert 'LEFT(dim_code[code], 4) = "SALE"' in measures[0].expression
        assert measures[0].expression.endswith(")")
        assert measures[0].display_folder == "01. Revenue"

    def test_fenced_expression(self) -> None:
        measures, _ = parse_tmdl_file(
            tmdl("""\
            table _Measures
                measure Note = ```
                        "some text"
                        ```
                    formatString: 0
            """)
        )
        assert measures[0].expression == '"some text"'

    def test_property_lines_never_leak_into_the_expression(self) -> None:
        measures, _ = parse_tmdl_file(
            tmdl("""\
            table _Measures
                measure 'A' =
                        SUM(fct_orders[amount])
                    formatString: #,0
                    lineageTag: 1234
            """)
        )
        assert measures[0].expression == "SUM(fct_orders[amount])"


class TestDescriptions:
    def test_triple_slash_lines_become_the_description(self) -> None:
        measures, _ = parse_tmdl_file(
            tmdl("""\
            table _Measures
                /// Net revenue excluding VAT.
                measure 'Net' = SUM(fct_orders[amount])
            """)
        )
        assert measures[0].description == "Net revenue excluding VAT."

    def test_description_does_not_carry_to_the_next_measure(self) -> None:
        measures, _ = parse_tmdl_file(
            tmdl("""\
            table _Measures
                /// Only mine.
                measure 'A' = SUM(fct_orders[amount])
                    formatString: #,0
                measure 'B' = SUM(fct_orders[qty])
            """)
        )
        assert measures[0].description == "Only mine."
        assert measures[1].description == ""


class TestModelDirectory:
    def test_accepts_the_model_folder_itself(self, tmp_path) -> None:
        (tmp_path / "definition" / "tables").mkdir(parents=True)
        assert find_model_directory(tmp_path) == tmp_path

    def test_accepts_a_parent_holding_one_model(self, tmp_path) -> None:
        model = tmp_path / "Sales.SemanticModel"
        (model / "definition" / "tables").mkdir(parents=True)
        assert find_model_directory(tmp_path) == model

    def test_ignores_report_folders_beside_the_model(self, tmp_path) -> None:
        # A PBIP project always ships at least one .Report next to the model,
        # and reports carry a definition/ too — matching on that alone makes
        # every real project look ambiguous.
        model = tmp_path / "Sales.SemanticModel"
        (model / "definition" / "tables").mkdir(parents=True)
        (tmp_path / "Sales.Report" / "definition").mkdir(parents=True)
        assert find_model_directory(tmp_path) == model

    def test_refuses_to_guess_between_two_models(self, tmp_path) -> None:
        for name in ("A.SemanticModel", "B.SemanticModel"):
            (tmp_path / name / "definition" / "tables").mkdir(parents=True)
        with pytest.raises(ValueError, match="several semantic models"):
            find_model_directory(tmp_path)

    def test_missing_model_is_an_error(self, tmp_path) -> None:
        with pytest.raises(FileNotFoundError):
            find_model_directory(tmp_path)


class TestReadModel:
    def test_reads_measures_and_flags_tables_without_a_source(self, tmp_path) -> None:
        tables = tmp_path / "definition" / "tables"
        tables.mkdir(parents=True)
        (tables / "facts.tmdl").write_text(
            tmdl("""\
            table fct_orders
                measure 'Total' = SUM(fct_orders[amount])
                partition fct_orders = m
                    mode: import
            """),
            encoding="utf-8",
        )
        (tables / "calc.tmdl").write_text(
            tmdl("""\
            table _levels
                partition _levels = calculated
                    mode: import
            """),
            encoding="utf-8",
        )
        model = read_model(tmp_path)
        assert [m.name for m in model.measures] == ["Total"]
        assert model.tables == {"fct_orders", "_levels"}
        # A calculated table has no upstream dbt model — callers must not warn.
        assert model.tables_without_source == {"_levels"}
