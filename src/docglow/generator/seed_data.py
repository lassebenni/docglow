"""Attach seed CSV contents as ``sample_data`` for the frontend Data tab.

Seeds are static CSV files in the dbt project. At site-generation time we read
each seed's ``path`` (e.g. ``seeds/dim_web_shop.csv``) and embed the rows in
the generated payload so the SPA can render the same interactive Data tab used
for warehouse-sampled models.

Columns flagged ``meta.pii: true`` or matching a built-in name heuristic are
withheld (``••••`` in the UI) — same contract as warehouse sample dumps.
"""

from __future__ import annotations

import csv
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docglow.generator.pii import classify_columns

logger = logging.getLogger(__name__)

DEFAULT_ROW_LIMIT = 1000


def _normalize_cell(value: str) -> str | None:
    stripped = value.strip()
    return stripped if stripped else None


def _resolve_seed_csv_path(project_dir: Path, rel_path: str) -> Path | None:
    csv_path = (project_dir / str(rel_path).replace("\\", "/")).resolve()
    try:
        csv_path.relative_to(project_dir.resolve())
    except ValueError:
        logger.warning(
            "Seed CSV path escapes project directory (%s) — skipping",
            rel_path,
        )
        return None
    return csv_path


def _load_seed_csv(
    path: Path,
    seed_columns: list[dict[str, Any]] | None,
    *,
    row_limit: int,
    delimiter: str = ",",
) -> tuple[list[str], list[str], list[list[Any]], int, dict[str, list[str]]] | None:
    """Parse a seed CSV in one pass. Returns columns, rows, total, excluded — or None."""
    try:
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.reader(handle, delimiter=delimiter)
            try:
                header = next(reader)
            except StopIteration:
                logger.warning("%s: seed CSV has no header row — skipping", path)
                return None

            all_columns = [col.strip() for col in header]
            if not all_columns or all(not col for col in all_columns):
                logger.warning("%s: seed CSV header is empty — skipping", path)
                return None
            if len(set(all_columns)) != len(all_columns):
                logger.warning("%s: seed CSV has duplicate column names — skipping", path)
                return None

            sampled_columns, excluded_columns = classify_columns(all_columns, seed_columns)
            sampled_indexes = [all_columns.index(col) for col in sampled_columns]

            rows: list[list[Any]] = []
            total = 0
            for raw_row in reader:
                if not raw_row or all(not cell.strip() for cell in raw_row):
                    continue
                total += 1
                if len(rows) >= row_limit:
                    continue
                normalized = list(raw_row)
                if len(normalized) < len(all_columns):
                    normalized.extend([""] * (len(all_columns) - len(normalized)))
                elif len(normalized) > len(all_columns):
                    normalized = normalized[: len(all_columns)]
                rows.append(
                    [_normalize_cell(normalized[idx]) for idx in sampled_indexes],
                )
    except OSError as exc:
        logger.warning("Failed to read seed CSV %s: %s", path, exc)
        return None

    return all_columns, sampled_columns, rows, total, excluded_columns


def _build_payload(
    seed: dict[str, Any],
    all_columns: list[str],
    sampled_columns: list[str],
    rows: list[list[Any]],
    total_rows: int,
    row_limit: int,
    excluded_columns: dict[str, list[str]],
    generated_at: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": seed.get("schema") or "",
        "table": seed.get("name") or "",
        "columns": sampled_columns,
        "rows": rows,
        "row_count": total_rows,
        "limit": row_limit,
        "generated_at": generated_at,
        "all_columns": all_columns,
    }
    if excluded_columns["pii_meta"] or excluded_columns["name_flagged"]:
        payload["excluded_columns"] = excluded_columns
    return payload


def attach_seed_data(
    seeds: dict[str, dict[str, Any]],
    project_dir: Path | None,
    *,
    row_limit: int = DEFAULT_ROW_LIMIT,
    enabled: bool = True,
) -> None:
    """Read each seed's project CSV and attach ``sample_data``.

    Mutates ``seeds`` in place.  Package seeds and seeds whose CSV cannot be
    read are skipped with a warning; site generation continues.
    """
    if not enabled or project_dir is None:
        return

    project_dir = Path(project_dir)
    attached = 0

    for seed in seeds.values():
        if seed.get("is_package"):
            continue
        if seed.get("sample_data"):
            continue

        rel_path = seed.get("path")
        if not rel_path:
            continue

        csv_path = _resolve_seed_csv_path(project_dir, str(rel_path))
        if csv_path is None or not csv_path.is_file():
            logger.warning(
                "Seed CSV not found at %s — skipping Data tab for %s",
                csv_path or rel_path,
                seed.get("name"),
            )
            continue

        parsed = _load_seed_csv(
            csv_path,
            seed.get("columns"),
            row_limit=row_limit,
            delimiter=seed.get("csv_delimiter") or ",",
        )
        if parsed is None:
            continue

        all_columns, sampled_columns, rows, total_rows, excluded_columns = parsed
        generated_at = datetime.fromtimestamp(
            csv_path.stat().st_mtime,
            tz=timezone.utc,
        ).strftime("%Y-%m-%dT%H:%M:%SZ")

        seed["sample_data"] = _build_payload(
            seed,
            all_columns,
            sampled_columns,
            rows,
            total_rows,
            row_limit,
            excluded_columns,
            generated_at,
        )
        attached += 1

    logger.info("Attached seed CSV sample_data to %d seed(s) from %s", attached, project_dir)
