"""Tests for the --enable-erd CLI flag (DOC-213 / U1).

Confirms the flag is recognized by the generate command and propagates through
generate_site() so the pipeline stage (DOC-213 / U3) can be gated on it.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from docglow.cli import cli


def _make_mock_config(*, enable_erd: bool = False) -> MagicMock:
    """Mirror the helper used in tests/test_cli_warnings.py."""
    config = MagicMock()
    config.ai.enabled = False
    config.title = "docglow"
    config.slim = False
    config.column_lineage = False
    config.enable_erd = enable_erd
    return config


class TestEnableErdFlag:
    def test_flag_appears_in_help(self) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["generate", "--help"], catch_exceptions=False)
        assert "--enable-erd" in result.output
        assert "ERD view" in result.output

    def test_flag_propagates_to_generate_site(self, tmp_path: Path) -> None:
        runner = CliRunner()
        with (
            patch("docglow.config.load_config", return_value=_make_mock_config()),
            patch("docglow.generator.site.generate_site") as mock_gen,
        ):
            mock_gen.return_value = (tmp_path / "out", 100.0)
            result = runner.invoke(
                cli,
                ["generate", "--project-dir", str(tmp_path), "--enable-erd"],
                catch_exceptions=False,
            )

        assert result.exit_code == 0, result.output
        assert mock_gen.called
        kwargs = mock_gen.call_args.kwargs
        assert kwargs.get("enable_erd") is True

    def test_flag_defaults_to_false(self, tmp_path: Path) -> None:
        runner = CliRunner()
        with (
            patch("docglow.config.load_config", return_value=_make_mock_config()),
            patch("docglow.generator.site.generate_site") as mock_gen,
        ):
            mock_gen.return_value = (tmp_path / "out", 100.0)
            result = runner.invoke(
                cli,
                ["generate", "--project-dir", str(tmp_path)],
                catch_exceptions=False,
            )

        assert result.exit_code == 0, result.output
        assert mock_gen.called
        kwargs = mock_gen.call_args.kwargs
        assert kwargs.get("enable_erd") is False

    def test_yml_enable_erd_propagates_without_cli_flag(self, tmp_path: Path) -> None:
        """`enable_erd: true` in docglow.yml should turn the ERD on without the CLI flag."""
        runner = CliRunner()
        with (
            patch(
                "docglow.config.load_config",
                return_value=_make_mock_config(enable_erd=True),
            ),
            patch("docglow.generator.site.generate_site") as mock_gen,
        ):
            mock_gen.return_value = (tmp_path / "out", 100.0)
            result = runner.invoke(
                cli,
                ["generate", "--project-dir", str(tmp_path)],
                catch_exceptions=False,
            )

        assert result.exit_code == 0, result.output
        assert mock_gen.call_args.kwargs.get("enable_erd") is True

    def test_cli_flag_works_when_yml_disables(self, tmp_path: Path) -> None:
        """CLI flag enables the ERD even if yml omits / disables it."""
        runner = CliRunner()
        with (
            patch(
                "docglow.config.load_config",
                return_value=_make_mock_config(enable_erd=False),
            ),
            patch("docglow.generator.site.generate_site") as mock_gen,
        ):
            mock_gen.return_value = (tmp_path / "out", 100.0)
            result = runner.invoke(
                cli,
                ["generate", "--project-dir", str(tmp_path), "--enable-erd"],
                catch_exceptions=False,
            )

        assert result.exit_code == 0, result.output
        assert mock_gen.call_args.kwargs.get("enable_erd") is True
