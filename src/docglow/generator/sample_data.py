"""Attach pre-rendered sample-data markdown to model payloads.

Pattern: an external tool (e.g. a dbt project script) queries a small sample
of rows from each model's warehouse table and writes one Markdown file per
model into a directory, named ``<model_name>.md``.  At site-generation time,
docglow reads any matching file and attaches its contents to the model's
``sample_data_md`` field; the frontend renders it as a "Data" tab.

The sample data is intentionally a static artifact, not a live query — the
generated site is a static HTML bundle and must not depend on warehouse
credentials.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def attach_sample_data(
    models: dict[str, dict[str, Any]],
    sample_data_dir: Path | None,
) -> None:
    """Attach ``sample_data_md`` to each model dict from <dir>/<name>.md.

    Mutates ``models`` in place.  No-op when ``sample_data_dir`` is ``None``
    or does not exist.  Files that match a model name are read as UTF-8;
    read errors are logged and skipped (the site still generates).
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
        path = sample_data_dir / f"{name}.md"
        if not path.is_file():
            continue
        try:
            model["sample_data_md"] = path.read_text(encoding="utf-8")
            attached += 1
        except OSError as e:
            logger.warning("Failed to read %s: %s", path, e)

    logger.info("Attached sample_data_md to %d model(s) from %s", attached, sample_data_dir)
