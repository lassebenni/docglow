"""Tests for docglow.generator.sample_data.attach_sample_data.

Covers the fail-soft contract end-to-end:

- Happy path: a well-formed <model>.json is attached as model['sample_data'].
- Missing file: the model is left untouched (no key added, no exception).
- Malformed JSON: the file is logged and skipped; site generation still ships.
- Schema mismatch: missing required keys → skipped, no partial payload.
- Missing dir: the entire step is a no-op with a warning.
- None dir: no-op (used when --sample-data-dir is not passed).
"""

from __future__ import annotations

import json
import logging

from docglow.generator.sample_data import attach_sample_data


def _sample_payload() -> dict:
    return {
        "schema": "dbt_prod",
        "table": "my_model",
        "columns": ["id", "value"],
        "rows": [[1, "a"], [2, "b"]],
        "row_count": 2,
        "limit": 25,
        "generated_at": "2026-06-04T05:00:00Z",
    }


def test_attach_happy_path(tmp_path):
    payload = _sample_payload()
    (tmp_path / "my_model.json").write_text(json.dumps(payload), encoding="utf-8")
    models = {"model.x.my_model": {"name": "my_model"}}

    attach_sample_data(models, tmp_path)

    assert models["model.x.my_model"]["sample_data"] == payload


def test_attach_skips_models_without_matching_file(tmp_path):
    models = {"model.x.other": {"name": "other"}}
    attach_sample_data(models, tmp_path)
    assert "sample_data" not in models["model.x.other"]


def test_attach_skips_malformed_json(tmp_path, caplog):
    (tmp_path / "broken.json").write_text("{not: valid json", encoding="utf-8")
    models = {"model.x.broken": {"name": "broken"}}

    with caplog.at_level(logging.WARNING, logger="docglow.generator.sample_data"):
        attach_sample_data(models, tmp_path)

    assert "sample_data" not in models["model.x.broken"]
    assert any("not valid JSON" in r.message for r in caplog.records)


def test_attach_skips_payload_missing_required_keys(tmp_path, caplog):
    bad = {"schema": "s", "table": "t"}  # missing columns/rows/etc.
    (tmp_path / "bad.json").write_text(json.dumps(bad), encoding="utf-8")
    models = {"model.x.bad": {"name": "bad"}}

    with caplog.at_level(logging.WARNING, logger="docglow.generator.sample_data"):
        attach_sample_data(models, tmp_path)

    assert "sample_data" not in models["model.x.bad"]
    assert any("missing required keys" in r.message for r in caplog.records)


def test_attach_noop_on_missing_dir(tmp_path, caplog):
    nowhere = tmp_path / "does-not-exist"
    models = {"model.x.m": {"name": "m"}}

    with caplog.at_level(logging.WARNING, logger="docglow.generator.sample_data"):
        attach_sample_data(models, nowhere)

    assert "sample_data" not in models["model.x.m"]
    assert any("does not exist" in r.message for r in caplog.records)


def test_attach_noop_on_none_dir():
    models = {"model.x.m": {"name": "m"}}
    attach_sample_data(models, None)
    assert "sample_data" not in models["model.x.m"]
