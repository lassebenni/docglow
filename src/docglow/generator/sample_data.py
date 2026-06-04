"""Attach pre-dumped sample-data JSON to model payloads.

Pattern: an external tool (e.g. a dbt project script) queries a small sample
of rows from each model's warehouse table and writes one JSON file per model
into a directory, named ``<model_name>.json`` with this shape::

    {
        "schema": "dbt_prod_exports",
        "table": "exp_thunderstock_sku_catalog",
        "columns": ["sku_code", ...],
        "rows": [["006_001_ONE", ...], ...],
        "row_count": 25,
        "limit": 25,
        "generated_at": "2026-06-03T19:55:00Z"
    }

At site-generation time, docglow reads any matching file and attaches the
parsed payload to the model's ``sample_data`` field; the frontend renders it
as an interactive "Data" tab (sortable headers, substring search, horizontal
scroll).

The sample data is intentionally a static artifact, not a live query — the
generated site is a static HTML bundle and must not depend on warehouse
credentials.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_REQUIRED_KEYS = ("schema", "table", "columns", "rows", "row_count", "limit", "generated_at")


def _validate_payload(payload: Any, path: Path) -> dict[str, Any] | None:
    """Return ``payload`` if it matches the expected shape; ``None`` otherwise.

    Logs a single warning per rejected file so a malformed dump never breaks
    site generation.
    """
    if not isinstance(payload, dict):
        logger.warning("%s: top-level value must be an object — skipping", path)
        return None
    missing = [k for k in _REQUIRED_KEYS if k not in payload]
    if missing:
        logger.warning("%s: missing required keys %s — skipping", path, missing)
        return None
    if not isinstance(payload["columns"], list) or not isinstance(payload["rows"], list):
        logger.warning("%s: 'columns' and 'rows' must be lists — skipping", path)
        return None
    return payload


def attach_sample_data(
    models: dict[str, dict[str, Any]],
    sample_data_dir: Path | None,
) -> None:
    """Attach ``sample_data`` to each model dict from <dir>/<name>.json.

    Mutates ``models`` in place.  No-op when ``sample_data_dir`` is ``None``
    or does not exist.  Read / parse / validation errors are logged and
    skipped — the site still generates.
    """
    if sample_data_dir is None:
        return

    sample_data_dir = Path(sample_data_dir)
    if not sample_data_dir.is_dir():
        logger.warning("Sample data directory %s does not exist — skipping", sample_data_dir)
        return

    attached = 0
    for model in models.values():
        name = model.get("name")
        if not name:
            continue
        path = sample_data_dir / f"{name}.json"
        if not path.is_file():
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as e:
            logger.warning("Failed to read %s: %s", path, e)
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.warning("%s: not valid JSON (%s) — skipping", path, e)
            continue
        validated = _validate_payload(payload, path)
        if validated is None:
            continue
        model["sample_data"] = validated
        attached += 1

    logger.info("Attached sample_data to %d model(s) from %s", attached, sample_data_dir)
