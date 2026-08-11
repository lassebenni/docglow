"""Ingest external exposure field lineage (e.g. Power BI measures → mart columns).

Sidecar JSON schema (version 1)::

    {
      "version": 1,
      "exposures": {
        "<exposure_name>": {
          "fields": [
            {
              "name": "<measure or field name>",
              "kind": "measure",
              "depends_on": [
                {"model": "<dbt_model_name>", "column": "<col>", "transformation": "aggregated"}
              ],
              "components": ["<other_field_name>", ...],
              "expression": "<optional measure formula / DAX>"
            }
          ]
        }
      }
    }

Exposure keys are names (not unique_ids). Model names in ``depends_on`` are
resolved against the manifest. ``components`` are expanded transitively to
leaf mart-column deps at merge time. Optional ``expression`` is attached to
lineage deps so the column detail panel can show a Formula block.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SUPPORTED_VERSION = 1
# Must match Docglow / shared-types TransformationType (not renamed/cast).
_VALID_TRANSFORMATIONS = frozenset(
    {"passthrough", "rename", "derived", "aggregated", "constant"}
)
_TRANSFORMATION_ALIASES: dict[str, str] = {
    "renamed": "rename",
    "cast": "passthrough",
}
_DEFAULT_TRANSFORMATION = "aggregated"

# Column-like tokens inside expression mart_columns (e.g. "a + b").
_COLUMN_TOKEN_RE = re.compile(r"\b([a-z_][a-z0-9_]*)\b", re.IGNORECASE)
# Tokens that look like identifiers but are SQL keywords / noise in expressions.
_SQL_NOISE_TOKENS = frozenset(
    {
        "and",
        "as",
        "between",
        "case",
        "cast",
        "coalesce",
        "distinct",
        "else",
        "end",
        "false",
        "from",
        "iff",
        "ifnull",
        "in",
        "is",
        "like",
        "not",
        "null",
        "nullif",
        "or",
        "then",
        "true",
        "when",
    }
)


def load_exposure_field_lineage(path: Path) -> dict[str, Any]:
    """Load and validate an exposure field lineage sidecar JSON file."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"exposure field lineage root must be an object: {path}")

    version = raw.get("version")
    if version != SUPPORTED_VERSION:
        raise ValueError(
            f"unsupported exposure field lineage version {version!r} "
            f"(expected {SUPPORTED_VERSION}) in {path}"
        )

    exposures = raw.get("exposures")
    if not isinstance(exposures, dict):
        raise ValueError(f"exposure field lineage missing 'exposures' object: {path}")

    return raw


def collect_mart_model_names(sidecar: dict[str, Any]) -> set[str]:
    """Return unique dbt model names referenced by field ``depends_on`` entries.

    Used to expand ``--column-lineage-select`` so marts that only appear via
    Power BI / exposure field lineage still get SQL column lineage analyzed
    (otherwise the graph stops at those leaves with no upstream).
    """
    names: set[str] = set()
    exposures = sidecar.get("exposures")
    if not isinstance(exposures, dict):
        return names
    for exp in exposures.values():
        if not isinstance(exp, dict):
            continue
        for field in exp.get("fields") or []:
            if not isinstance(field, dict):
                continue
            for dep in field.get("depends_on") or []:
                if not isinstance(dep, dict):
                    continue
                model = dep.get("model")
                if isinstance(model, str) and model.strip():
                    names.add(model.strip())
    return names


def _build_name_indexes(
    exposures: dict[str, Any],
    models: dict[str, Any],
    seeds: dict[str, Any],
    snapshots: dict[str, Any],
    sources: dict[str, Any],
) -> tuple[dict[str, str], dict[str, str]]:
    """Return (exposure_name → uid, model_name → uid) indexes."""
    exposure_by_name: dict[str, str] = {}
    for uid, data in exposures.items():
        name = data.get("name")
        if isinstance(name, str) and name:
            exposure_by_name[name] = uid

    model_by_name: dict[str, str] = {}
    for collection in (models, seeds, snapshots):
        for uid, data in collection.items():
            name = data.get("name")
            if isinstance(name, str) and name and name not in model_by_name:
                model_by_name[name] = uid

    for uid, data in sources.items():
        # Prefer bare table name; also index "source_name.table_name" if present.
        name = data.get("name")
        if isinstance(name, str) and name and name not in model_by_name:
            model_by_name[name] = uid
        source_name = data.get("source_name")
        if isinstance(source_name, str) and isinstance(name, str) and name:
            qualified = f"{source_name}.{name}"
            if qualified not in model_by_name:
                model_by_name[qualified] = uid

    return exposure_by_name, model_by_name


def _normalize_columns(column: str) -> list[str]:
    """Split expression-like column strings into identifier tokens."""
    column = column.strip()
    if not column:
        return []
    if re.fullmatch(r"[a-z_][a-z0-9_]*", column, re.IGNORECASE):
        return [column]
    tokens: list[str] = []
    seen: set[str] = set()
    for token in _COLUMN_TOKEN_RE.findall(column):
        if token.lower() in _SQL_NOISE_TOKENS:
            continue
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    return tokens


def _normalize_transformation(raw: Any) -> str:
    """Map sidecar transformation strings onto Docglow's TransformationType."""
    if not isinstance(raw, str) or not raw.strip():
        return _DEFAULT_TRANSFORMATION
    key = raw.strip().lower()
    if key in _TRANSFORMATION_ALIASES:
        mapped = _TRANSFORMATION_ALIASES[key]
        logger.warning(
            "exposure field lineage: transformation %r mapped to %r",
            raw,
            mapped,
        )
        return mapped
    if key in _VALID_TRANSFORMATIONS:
        return key
    logger.warning(
        "exposure field lineage: unknown transformation %r; using %r",
        raw,
        _DEFAULT_TRANSFORMATION,
    )
    return _DEFAULT_TRANSFORMATION


def _direct_deps_for_field(
    field: dict[str, Any],
    model_by_name: dict[str, str],
) -> list[dict[str, str]]:
    """Resolve a field's ``depends_on`` entries to column_lineage dependency dicts."""
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for dep in field.get("depends_on") or []:
        if not isinstance(dep, dict):
            continue
        model_name = dep.get("model")
        column_raw = dep.get("column")
        if not isinstance(model_name, str) or not isinstance(column_raw, str):
            continue

        model_uid = model_by_name.get(model_name)
        if model_uid is None:
            logger.warning(
                "exposure field lineage: unknown model %r (field %r)",
                model_name,
                field.get("name"),
            )
            continue

        transformation = _normalize_transformation(dep.get("transformation", _DEFAULT_TRANSFORMATION))

        for column in _normalize_columns(column_raw):
            key = (model_uid, column)
            if key in seen:
                continue
            seen.add(key)
            result.append(
                {
                    "source_model": model_uid,
                    "source_column": column,
                    "transformation": transformation,
                }
            )

    return result


def _expand_field_deps(
    field_name: str,
    fields_by_name: dict[str, dict[str, Any]],
    model_by_name: dict[str, str],
    cache: dict[str, list[dict[str, str]]],
    stack: set[str],
) -> list[dict[str, str]]:
    """Transitively expand ``components`` to leaf mart-column dependencies."""
    if field_name in cache:
        return cache[field_name]

    if field_name in stack:
        logger.warning("exposure field lineage: cyclic components involving %r", field_name)
        return []

    field = fields_by_name.get(field_name)
    if field is None:
        logger.warning("exposure field lineage: unknown component field %r", field_name)
        return []

    stack.add(field_name)
    deps = list(_direct_deps_for_field(field, model_by_name))
    seen = {(d["source_model"], d["source_column"]) for d in deps}

    for component in field.get("components") or []:
        if not isinstance(component, str):
            continue
        for dep in _expand_field_deps(component, fields_by_name, model_by_name, cache, stack):
            key = (dep["source_model"], dep["source_column"])
            if key in seen:
                continue
            seen.add(key)
            deps.append(dep)

    stack.discard(field_name)
    cache[field_name] = deps
    return deps


# kpi_lineage ``formula_md`` may append hand-written lineage notes after the formula.
_FORMULA_NARRATIVE_START = re.compile(
    r"^\s*(?:"
    r"where\b.+\bis sourced from\b"
    r"|waarbij\s*:"
    r"|joined per\b"
    r"|note\s*:"
    r")\s*$",
    re.IGNORECASE,
)


def _strip_formula_narrative(text: str) -> str:
    """Drop narrative tails from kpi_lineage ``formula_md`` (keep the real formula)."""
    kept: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and (
            _FORMULA_NARRATIVE_START.match(line)
            or re.match(r"where\b.+\bis sourced from\b", stripped, re.IGNORECASE)
        ):
            break
        kept.append(line)
    return "\n".join(kept).strip()


def _field_expression(field: dict[str, Any]) -> str | None:
    """Prefer explicit expression, then formula_md (kpi_lineage).

    Narrative notes appended to ``formula_md`` (e.g. "where … is sourced from")
    are stripped so the Formula panel shows only the evaluable formula.
    """
    for key in ("expression", "formula", "formula_md"):
        value = field.get(key)
        if isinstance(value, str):
            text = _strip_formula_narrative(value.strip())
            if text:
                return text
    return None


def _attach_expression(
    deps: list[dict[str, str]],
    expression: str | None,
) -> list[dict[str, str]]:
    """Attach measure formula onto lineage deps for the column detail Formula panel.

    Puts ``expression`` on the first dep when upstream columns exist; otherwise
    emits a synthetic aggregated dep so formula-only fields still show Formula.
    """
    if not expression:
        return deps
    if deps:
        enriched = [dict(d) for d in deps]
        enriched[0] = {**enriched[0], "expression": expression}
        return enriched
    return [{"transformation": "aggregated", "expression": expression}]


def _field_column_payload(field: dict[str, Any]) -> dict[str, Any]:
    """Build a DocglowColumn-shaped dict for an exposure field."""
    name = field.get("name", "")
    kind = field.get("kind", "measure")
    description = field.get("description") or field.get("short_description") or ""
    meta: dict[str, Any] = {"kind": kind}
    if field.get("components"):
        meta["components"] = list(field["components"])
    expression = _field_expression(field)
    if expression:
        meta["expression"] = expression
    return {
        "name": name,
        "description": description if isinstance(description, str) else "",
        "data_type": "",
        "meta": meta,
        "tags": [],
        "tests": [],
        "profile": None,
    }


def apply_exposure_field_lineage(
    *,
    sidecar: dict[str, Any],
    exposures: dict[str, Any],
    models: dict[str, Any],
    seeds: dict[str, Any],
    snapshots: dict[str, Any],
    sources: dict[str, Any],
    column_lineage: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Merge sidecar fields onto exposures and into ``column_lineage``.

    Returns the (possibly new) column_lineage dict. Mutates ``exposures`` in place.
    """
    exposure_by_name, model_by_name = _build_name_indexes(
        exposures, models, seeds, snapshots, sources
    )

    lineage: dict[str, Any] = dict(column_lineage) if column_lineage else {}
    sidecar_exposures = sidecar.get("exposures") or {}

    for exposure_name, entry in sidecar_exposures.items():
        if not isinstance(entry, dict):
            continue
        exposure_uid = exposure_by_name.get(exposure_name)
        if exposure_uid is None:
            logger.warning(
                "exposure field lineage: unknown exposure name %r — skipping",
                exposure_name,
            )
            continue

        exposure = exposures.get(exposure_uid)
        if exposure is None:
            continue

        fields_raw = entry.get("fields") or []
        if not isinstance(fields_raw, list):
            continue

        fields_by_name: dict[str, dict[str, Any]] = {}
        ordered_fields: list[dict[str, Any]] = []
        for field in fields_raw:
            if not isinstance(field, dict):
                continue
            name = field.get("name")
            if not isinstance(name, str) or not name:
                continue
            fields_by_name[name] = field
            ordered_fields.append(field)

        expand_cache: dict[str, list[dict[str, str]]] = {}
        columns: list[dict[str, Any]] = []
        field_lineage: dict[str, list[dict[str, str]]] = {}

        for field in ordered_fields:
            name = field["name"]
            columns.append(_field_column_payload(field))
            deps = _expand_field_deps(name, fields_by_name, model_by_name, expand_cache, set())
            deps = _attach_expression(deps, _field_expression(field))
            if deps:
                field_lineage[name] = deps

        exposure["columns"] = columns
        if field_lineage:
            existing = lineage.get(exposure_uid)
            if isinstance(existing, dict):
                merged = dict(existing)
                merged.update(field_lineage)
                lineage[exposure_uid] = merged
            else:
                lineage[exposure_uid] = field_lineage

    return lineage if lineage else column_lineage
