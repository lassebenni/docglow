"""Derive exposure field lineage from a Power BI TMDL model.

Turns a semantic model folder into the same sidecar structure
``--exposure-field-lineage`` accepts, so a Power BI dashboard's measures become
columns on a dbt exposure and their lineage merges into the column graph. See
:mod:`docglow.lineage.exposure_field_lineage` for the schema and the merge.

A measure's DAX names a *Power BI table*. In a dbt-backed model those tables are
imported straight from marts and keep the model's name, so a table is resolved
to a dbt model by name. Tables that resolve to nothing are reported once at the
end rather than per measure: a model has one date dimension and hundreds of
measures touching it, so per-measure warnings would bury the signal.
"""

from __future__ import annotations

import logging
from typing import Any

from docglow.lineage.powerbi_dax import DaxParserUnavailableError, analyze, is_dimension
from docglow.lineage.powerbi_tmdl import TmdlModel, read_model

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
# Every measure lands on its column through an aggregation (SUM/COUNT/...).
DEFAULT_TRANSFORMATION = "aggregated"


def build_sidecar(
    model: TmdlModel,
    *,
    exposure_name: str,
    known_models: set[str],
) -> dict[str, Any]:
    """Build a version-1 exposure field lineage payload from a parsed TMDL model."""
    fields: list[dict[str, Any]] = []
    unresolved: dict[str, int] = {}
    parse_failures: list[str] = []
    # `[Name]` is a measure reference *or* a column of a virtual table built by
    # ADDCOLUMNS/SELECTCOLUMNS — `ADDCOLUMNS(t, "v_cy", ...)` is then read as
    # `[v_cy]`. The two are identical in the grammar, so the model's own measure
    # list is what separates them; anything else is a virtual column, not a
    # component, and recording it would invent lineage between measures.
    measure_names = {m.name for m in model.measures}

    for measure in model.measures:
        if not measure.expression:
            continue
        lineage = analyze(measure.expression)
        if lineage.parse_error:
            parse_failures.append(measure.name)
            # Keep the measure: the formula is still worth showing even when
            # its dependencies could not be read.
            depends_on: list[dict[str, str]] = []
            components: list[str] = []
        else:
            depends_on = []
            for ref in lineage.columns:
                if ref.table in known_models:
                    depends_on.append(
                        {
                            "model": ref.table,
                            "column": ref.column,
                            "transformation": DEFAULT_TRANSFORMATION,
                        }
                    )
                elif not is_dimension(ref.table) and ref.table not in model.tables_without_source:
                    unresolved[ref.table] = unresolved.get(ref.table, 0) + 1
            components = [c for c in lineage.components if c in measure_names]

        field: dict[str, Any] = {
            "name": measure.name,
            "kind": "measure",
            "description": measure.description,
            "expression": measure.expression,
            "depends_on": depends_on,
        }
        if components:
            field["components"] = components
        fields.append(field)

    if parse_failures:
        logger.warning(
            "Power BI model: %d measure(s) had unreadable DAX, kept without lineage (e.g. %s)",
            len(parse_failures),
            ", ".join(sorted(parse_failures)[:3]),
        )
    if unresolved:
        listed = ", ".join(f"{t} ({n})" for t, n in sorted(unresolved.items())[:5])
        logger.warning(
            "Power BI model: %d table(s) matched no dbt model, their columns are not linked: %s",
            len(unresolved),
            listed,
        )

    resolved = sum(1 for f in fields if f["depends_on"])
    logger.info(
        "Power BI model: %d measures, %d with dbt column lineage, exposure %r",
        len(fields),
        resolved,
        exposure_name,
    )
    return {"version": SCHEMA_VERSION, "exposures": {exposure_name: {"fields": fields}}}


def sidecar_from_model_dir(
    path: Any,
    *,
    exposure_name: str,
    known_models: set[str],
) -> dict[str, Any] | None:
    """Read a TMDL model folder and build its sidecar. ``None`` on failure.

    Site generation is fail-soft: a missing extra or an unreadable model
    degrades the docs, it does not abort the build.
    """
    try:
        model = read_model(path)
    except (OSError, ValueError) as exc:
        logger.warning("Power BI model: cannot read %s (%s) — skipping", path, exc)
        return None
    try:
        return build_sidecar(model, exposure_name=exposure_name, known_models=known_models)
    except DaxParserUnavailableError as exc:
        logger.warning("Power BI model: %s — skipping", exc)
        return None
