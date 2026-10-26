"""The --powerbi-model flag must actually reach the stages that use it.

Every module behind this flag was unit-tested and the whole feature still did
nothing: the pipeline gated the merge stage on the *old* sidecar option and
dropped the new arguments on the way to column lineage. Unit tests cannot see
that — only assertions about the assembled pipeline can.
"""

from __future__ import annotations

import textwrap
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from docglow.generator.pipeline import (
    PipelineContext,
    default_stages,
    stage_build_column_lineage,
    stage_merge_exposure_field_lineage,
)


def _context(**kwargs) -> PipelineContext:
    return PipelineContext(artifacts=MagicMock(), **kwargs)


def _stage(ctx: PipelineContext, name: str):
    return next(s for s in default_stages(ctx) if s.name == name)


def _write_model(root: Path) -> Path:
    """A minimal but real TMDL semantic model — one table, one measure."""
    tables = root / "definition" / "tables"
    tables.mkdir(parents=True)
    (tables / "measures.tmdl").write_text(
        textwrap.dedent("""\
        table _Measures
            /// Total revenue.
            measure 'Total Revenue' = SUM(fct_orders[amount])
                formatString: #,0
        """).replace("    ", "\t"),
        encoding="utf-8",
    )
    return root


class TestMergeStageIsEnabled:
    """The bug: the stage was gated on exposure_field_lineage_path alone."""

    def test_enabled_for_a_powerbi_model_alone(self, tmp_path: Path) -> None:
        ctx = _context(powerbi_model_path=tmp_path, powerbi_exposure="dash")
        assert _stage(ctx, "merge_exposure_field_lineage").enabled

    def test_enabled_for_a_sidecar_alone(self, tmp_path: Path) -> None:
        ctx = _context(exposure_field_lineage_path=tmp_path / "sidecar.json")
        assert _stage(ctx, "merge_exposure_field_lineage").enabled

    def test_disabled_when_neither_is_given(self) -> None:
        assert not _stage(_context(), "merge_exposure_field_lineage").enabled


class TestColumnLineageStageForwardsTheModel:
    """The other bug: the arguments were accepted downstream but never passed."""

    def test_model_path_and_known_names_reach_the_builder(self, tmp_path: Path) -> None:
        ctx = _context(
            column_lineage_enabled=True,
            powerbi_model_path=tmp_path,
            powerbi_exposure="dash",
        )
        ctx.models = {"model.p.fct_orders": {"name": "fct_orders"}}
        with patch(
            "docglow.generator.data._build_column_lineage",
            return_value=(None, None, None, None, None),
        ) as builder:
            stage_build_column_lineage(ctx)
        kwargs = builder.call_args.kwargs
        assert kwargs["powerbi_model_path"] == tmp_path
        assert "fct_orders" in kwargs["known_model_names"]


class TestMeasuresReachTheExposure:
    """End to end through the stage: a model folder in, lineage out."""

    @pytest.fixture
    def ctx(self, tmp_path: Path) -> PipelineContext:
        ctx = _context(
            powerbi_model_path=_write_model(tmp_path / "Sales.SemanticModel"),
            powerbi_exposure="sales_dashboard",
        )
        ctx.exposures = {"exposure.p.sales_dashboard": {"name": "sales_dashboard"}}
        ctx.models = {"model.p.fct_orders": {"name": "fct_orders"}}
        return ctx

    def test_measures_become_exposure_columns(self, ctx: PipelineContext) -> None:
        pytest.importorskip("pbi_parsers", reason="needs the 'powerbi' extra")
        stage_merge_exposure_field_lineage(ctx)
        columns = ctx.exposures["exposure.p.sales_dashboard"]["columns"]
        assert [c["name"] for c in columns] == ["Total Revenue"]
        assert columns[0]["description"] == "Total revenue."

    def test_measure_gains_column_lineage(self, ctx: PipelineContext) -> None:
        pytest.importorskip("pbi_parsers", reason="needs the 'powerbi' extra")
        stage_merge_exposure_field_lineage(ctx)
        deps = ctx.column_lineage["exposure.p.sales_dashboard"]["Total Revenue"]
        assert [(d["source_model"], d["source_column"]) for d in deps] == [
            ("model.p.fct_orders", "amount")
        ]

    def test_missing_exposure_name_is_a_no_op_not_a_crash(self, ctx: PipelineContext) -> None:
        ctx.powerbi_exposure = None
        stage_merge_exposure_field_lineage(ctx)
        assert "columns" not in ctx.exposures["exposure.p.sales_dashboard"]


class TestCliFlags:
    def test_model_without_exposure_fails_fast(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from docglow.cli import cli

        result = CliRunner().invoke(
            cli, ["generate", "--project-dir", str(tmp_path), "--powerbi-model", str(tmp_path)]
        )
        assert result.exit_code != 0
        assert "requires --powerbi-exposure" in result.output

    def test_exposure_without_model_fails_fast(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from docglow.cli import cli

        result = CliRunner().invoke(
            cli, ["generate", "--project-dir", str(tmp_path), "--powerbi-exposure", "dash"]
        )
        assert result.exit_code != 0
        assert "requires --powerbi-model" in result.output

    def test_flags_reach_generate_site(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from docglow.cli import cli

        model = _write_model(tmp_path / "Sales.SemanticModel")
        config = MagicMock()
        config.ai.enabled = False
        config.title = "docglow"
        config.slim = False
        config.column_lineage = False
        config.enable_erd = False
        with (
            patch("docglow.config.load_config", return_value=config),
            patch("docglow.generator.site.generate_site") as generate_site,
        ):
            generate_site.return_value = (tmp_path, 100.0)
            CliRunner().invoke(
                cli,
                [
                    "generate",
                    "--project-dir",
                    str(tmp_path),
                    "--powerbi-model",
                    str(model),
                    "--powerbi-exposure",
                    "sales_dashboard",
                ],
                catch_exceptions=False,
            )
        kwargs = generate_site.call_args.kwargs
        assert kwargs["powerbi_model_path"] == model
        assert kwargs["powerbi_exposure"] == "sales_dashboard"
