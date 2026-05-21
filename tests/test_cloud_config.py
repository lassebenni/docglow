"""Tests for Docglow Cloud config + API URL override precedence."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from docglow.cli import cli
from docglow.cloud import config as cloud_config
from docglow.cloud.config import DEFAULT_API_URL, load_cloud_config


@pytest.fixture(autouse=True)
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect ~/.docglow/config.json to tmp and clear cloud env vars."""
    config_dir = tmp_path / ".docglow"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(cloud_config, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(cloud_config, "CONFIG_FILE", config_file)
    monkeypatch.delenv("DOCGLOW_API_URL", raising=False)
    monkeypatch.delenv("DOCGLOW_TOKEN", raising=False)
    return config_file


def test_default_api_url_points_at_production_app() -> None:
    """Regression guard: DEFAULT_API_URL must resolve. api.docglow.dev does not."""
    assert DEFAULT_API_URL == "https://app.docglow.com"


def test_load_cloud_config_uses_default_when_unset() -> None:
    config = load_cloud_config()
    assert config.api_base_url == "https://app.docglow.com"


def test_load_cloud_config_env_var_overrides_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOCGLOW_API_URL", "https://app-staging.docglow.com")
    config = load_cloud_config()
    assert config.api_base_url == "https://app-staging.docglow.com"


def test_load_cloud_config_file_overrides_default(isolated_config: Path) -> None:
    isolated_config.parent.mkdir(parents=True, exist_ok=True)
    isolated_config.write_text(json.dumps({"api_base_url": "https://app-dev.docglow.com"}))
    config = load_cloud_config()
    assert config.api_base_url == "https://app-dev.docglow.com"


def test_load_cloud_config_env_var_overrides_file(
    isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    isolated_config.parent.mkdir(parents=True, exist_ok=True)
    isolated_config.write_text(json.dumps({"api_base_url": "https://app-dev.docglow.com"}))
    monkeypatch.setenv("DOCGLOW_API_URL", "https://app-staging.docglow.com")
    config = load_cloud_config()
    assert config.api_base_url == "https://app-staging.docglow.com"


def _runner_invoke_publish(*extra_args: str) -> tuple[object, MagicMock]:
    """Invoke `docglow publish` with run_publish mocked. Returns (result, mock)."""
    runner = CliRunner()
    with runner.isolated_filesystem() as fs:
        project_dir = Path(fs)
        (project_dir / "target").mkdir()
        mock_run = MagicMock(return_value={"status": "complete", "site_url": ""})
        with patch("docglow.cloud.publish.run_publish", mock_run):
            result = runner.invoke(
                cli,
                [
                    "publish",
                    "--token",
                    "dg_live_test",
                    "--project-dir",
                    str(project_dir),
                    *extra_args,
                ],
            )
        return result, mock_run


def test_publish_api_url_flag_overrides_default() -> None:
    result, mock_run = _runner_invoke_publish("--api-url", "https://app-staging.docglow.com")
    assert result.exit_code == 0, result.output
    config = mock_run.call_args.args[0]
    assert config.api_base_url == "https://app-staging.docglow.com"


def test_publish_api_url_flag_overrides_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOCGLOW_API_URL", "https://app-dev.docglow.com")
    result, mock_run = _runner_invoke_publish("--api-url", "https://app-staging.docglow.com")
    assert result.exit_code == 0, result.output
    config = mock_run.call_args.args[0]
    assert config.api_base_url == "https://app-staging.docglow.com"


def test_publish_uses_default_when_no_flag_or_env() -> None:
    result, mock_run = _runner_invoke_publish()
    assert result.exit_code == 0, result.output
    config = mock_run.call_args.args[0]
    assert config.api_base_url == "https://app.docglow.com"
