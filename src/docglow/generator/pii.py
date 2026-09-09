"""PII column classification for sample-data payloads.

Shared by seed CSV embedding and (when vendored) warehouse dump scripts so
name-based heuristics stay in one place.
"""

from __future__ import annotations

import re
from typing import Any

PII_NAME_PATTERNS = (
    re.compile(r"(^|_)email($|_)", re.I),
    re.compile(r"(^|_)e_mail($|_)", re.I),
    re.compile(r"phone", re.I),
    re.compile(r"mobile", re.I),
    re.compile(r"\biban\b", re.I),
    re.compile(r"\bbsn\b", re.I),
    re.compile(r"\bssn\b", re.I),
    re.compile(r"date_of_birth", re.I),
    re.compile(r"\bdob\b", re.I),
    re.compile(r"birth_date", re.I),
    re.compile(r"password", re.I),
    re.compile(r"secret", re.I),
)


def is_pii_column_name(name: str) -> bool:
    return any(pattern.search(name) for pattern in PII_NAME_PATTERNS)


def classify_columns(
    header: list[str],
    seed_columns: list[dict[str, Any]] | None,
) -> tuple[list[str], dict[str, list[str]]]:
    """Return ``(sampled_column_names, excluded_columns)`` for a CSV header."""
    meta_by_name: dict[str, dict[str, Any]] = {}
    if seed_columns:
        for col in seed_columns:
            col_name = str(col.get("name") or "")
            if col_name:
                meta_by_name[col_name.lower()] = col

    pii_meta: list[str] = []
    name_flagged: list[str] = []
    sampled: list[str] = []

    for col_name in header:
        manifest_col = meta_by_name.get(col_name.lower())
        meta = manifest_col.get("meta", {}) if manifest_col else {}
        if meta.get("pii"):
            pii_meta.append(col_name)
        elif is_pii_column_name(col_name):
            name_flagged.append(col_name)
        else:
            sampled.append(col_name)

    excluded = {"pii_meta": pii_meta, "name_flagged": name_flagged}
    return sampled, excluded
