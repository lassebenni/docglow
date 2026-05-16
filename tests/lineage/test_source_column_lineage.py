"""End-to-end: column lineage terminates at sources.yml-declared source columns.

Covers DOC-226 / GH #93. The full path under test:
    sources.yml columns
    -> transform_source emits source dict with `columns`
    -> build_schema_mapping feeds them to SQLGlot
    -> analyze_column_lineage produces edges with source_model=source.* unique_id
"""

from __future__ import annotations

from pathlib import Path

from docglow.artifacts.manifest import ManifestColumnInfo, ManifestSource
from docglow.generator.transforms.sources import transform_source
from docglow.lineage.analyzer import analyze_column_lineage

SOURCE_UID = "source.proj.raw.events"
MODEL_UID = "model.proj.stg_events"


def _build_inputs() -> tuple[dict, dict]:
    """Build minimal docglow-data dicts: one manifest-only source + one staging model."""
    source = ManifestSource(
        unique_id=SOURCE_UID,
        name="events",
        source_name="raw",
        database="db",
        schema="raw",
        columns={
            "event_id": ManifestColumnInfo(name="event_id"),
            "user_id": ManifestColumnInfo(name="user_id"),
            "event_at": ManifestColumnInfo(name="event_at"),
        },
    )
    # Use the public transform so we exercise the merge code, not a hand-rolled dict.
    sources: dict[str, dict] = {
        SOURCE_UID: transform_source(source, _empty_catalog(), None),
    }

    models: dict[str, dict] = {
        MODEL_UID: {
            "unique_id": MODEL_UID,
            "name": "stg_events",
            "schema": "analytics",
            "database": "db",
            "compiled_sql": (
                'select event_id, user_id, event_at from {{ source("raw", "events") }}'
            ),
            "raw_sql": "select event_id, user_id, event_at from {{ source('raw','events') }}",
            "columns": [
                {"name": "event_id"},
                {"name": "user_id"},
                {"name": "event_at"},
            ],
            "depends_on": [SOURCE_UID],
        }
    }
    return models, sources


def _empty_catalog():
    from docglow.artifacts.catalog import Catalog

    return Catalog()


class TestManifestOnlySourceColumnLineage:
    def test_lineage_resolves_to_source_columns(self) -> None:
        models, sources = _build_inputs()

        # Pre-compiled SQL: substitute the dbt jinja so SQLGlot parses it.
        # The lineage analyzer expects compiled_sql to be real SQL.
        models[MODEL_UID]["compiled_sql"] = "select event_id, user_id, event_at from db.raw.events"

        # Tell the resolver how to find the source from the literal table ref.
        # In real artifacts this comes from manifest_sources[uid].relation_name.
        class _RelSource:
            relation_name = '"db"."raw"."events"'

        result = analyze_column_lineage(
            models=models,
            sources=sources,
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={SOURCE_UID: _RelSource()},
        )

        assert MODEL_UID in result, "model should have lineage entries"
        col_lineage = result[MODEL_UID]
        assert set(col_lineage.keys()) >= {"event_id", "user_id", "event_at"}

        for col_name in ("event_id", "user_id", "event_at"):
            deps = col_lineage[col_name]
            assert deps, f"{col_name} should have at least one upstream dep"
            source_deps = [d for d in deps if d["source_model"] == SOURCE_UID]
            assert source_deps, (
                f"{col_name} should resolve to the manifest-only source ({SOURCE_UID}), got {deps}"
            )
            assert source_deps[0]["source_column"].lower() == col_name

    def test_second_run_hits_cache(self, tmp_path: Path) -> None:
        models, sources = _build_inputs()
        models[MODEL_UID]["compiled_sql"] = "select event_id from db.raw.events"

        class _RelSource:
            relation_name = '"db"."raw"."events"'

        cache_path = tmp_path / ".docglow-cache.json"

        first = analyze_column_lineage(
            models=models,
            sources=sources,
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={SOURCE_UID: _RelSource()},
            cache_path=cache_path,
        )
        assert cache_path.exists()

        # Second run with the same cache file: identical lineage, populated from cache.
        second = analyze_column_lineage(
            models=models,
            sources=sources,
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={SOURCE_UID: _RelSource()},
            cache_path=cache_path,
        )
        assert first[MODEL_UID] == second[MODEL_UID]

    def test_source_with_no_columns_does_not_break_lineage(self) -> None:
        """Today's behavior preserved: source with no declared columns -> no source-level edges."""
        models, _ = _build_inputs()
        models[MODEL_UID]["compiled_sql"] = "select event_id from db.raw.events"

        empty_source_dict = transform_source(
            ManifestSource(
                unique_id=SOURCE_UID,
                name="events",
                source_name="raw",
                database="db",
                schema="raw",
            ),
            _empty_catalog(),
            None,
        )
        assert empty_source_dict["columns"] == []

        class _RelSource:
            relation_name = '"db"."raw"."events"'

        # Should not raise; model-level lineage may be empty or resolve only what it can.
        result = analyze_column_lineage(
            models=models,
            sources={SOURCE_UID: empty_source_dict},
            seeds={},
            snapshots={},
            dialect="postgres",
            manifest_sources={SOURCE_UID: _RelSource()},
        )
        # No assertion that columns exist — only that the analyzer completes cleanly.
        assert isinstance(result, dict)
