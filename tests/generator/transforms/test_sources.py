"""Tests for transform_source — manifest column merge + column tests passthrough."""

from __future__ import annotations

from docglow.artifacts.catalog import (
    Catalog,
    CatalogColumnInfo,
    CatalogNode,
    CatalogNodeMetadata,
)
from docglow.artifacts.manifest import (
    ManifestColumnInfo,
    ManifestNode,
    ManifestSource,
)
from docglow.artifacts.manifest import TestMetadata as DbtTestMetadata
from docglow.artifacts.run_results import RunResult
from docglow.generator.transforms.sources import transform_source

SOURCE_UID = "source.proj.raw.events"


def _make_source(*, columns: dict[str, ManifestColumnInfo] | None = None) -> ManifestSource:
    return ManifestSource(
        unique_id=SOURCE_UID,
        name="events",
        source_name="raw",
        database="db",
        schema="raw",
        columns=columns or {},
    )


def _make_catalog(columns: list[CatalogColumnInfo] | None = None) -> Catalog:
    if columns is None:
        return Catalog()
    cat_node = CatalogNode(
        unique_id=SOURCE_UID,
        metadata=CatalogNodeMetadata(name="events", schema="raw", database="db"),
        columns={c.name: c for c in columns},
    )
    return Catalog(sources={SOURCE_UID: cat_node})


def _make_test_node(
    *, name: str, column_name: str, test_type: str = "not_null", source_uid: str = SOURCE_UID
) -> ManifestNode:
    test_uid = f"test.proj.{name}"
    node = ManifestNode(
        unique_id=test_uid,
        name=name,
        resource_type="test",
        column_name=column_name,
        test_metadata=DbtTestMetadata(name=test_type),
    )
    node.depends_on.nodes = [source_uid]
    return node


class TestManifestOnly:
    """Source with sources.yml-declared columns and no catalog entry."""

    def test_manifest_columns_appear_with_descriptions(self) -> None:
        source = _make_source(
            columns={
                "event_id": ManifestColumnInfo(
                    name="event_id",
                    description="Primary key",
                    data_type="varchar",
                    tags=["pii"],
                    meta={"owner": "data"},
                ),
                "user_id": ManifestColumnInfo(name="user_id", description="FK to users"),
            }
        )

        result = transform_source(source, Catalog(), None)

        assert [c["name"] for c in result["columns"]] == ["event_id", "user_id"]

        event_id = result["columns"][0]
        assert event_id["description"] == "Primary key"
        assert event_id["data_type"] == "varchar"
        assert event_id["tags"] == ["pii"]
        assert event_id["meta"] == {"owner": "data"}
        assert event_id["tests"] == []

        user_id = result["columns"][1]
        assert user_id["data_type"] == ""  # not declared

    def test_manifest_data_type_none_coerces_to_empty_string(self) -> None:
        source = _make_source(
            columns={"event_id": ManifestColumnInfo(name="event_id", data_type=None)}
        )
        result = transform_source(source, Catalog(), None)
        assert result["columns"][0]["data_type"] == ""

    def test_no_columns_anywhere_returns_empty_list(self) -> None:
        result = transform_source(_make_source(), Catalog(), None)
        assert result["columns"] == []


class TestCatalogOnly:
    """Source with catalog columns and no sources.yml declarations — preserve today."""

    def test_catalog_drives_columns_in_order(self) -> None:
        catalog = _make_catalog(
            [
                CatalogColumnInfo(name="EVENT_ID", type="VARCHAR", index=0),
                CatalogColumnInfo(name="USER_ID", type="VARCHAR", index=1),
            ]
        )
        result = transform_source(_make_source(), catalog, None)
        assert [c["name"] for c in result["columns"]] == ["EVENT_ID", "USER_ID"]
        assert result["columns"][0]["data_type"] == "VARCHAR"
        assert result["columns"][0]["description"] == ""


class TestCatalogAndManifest:
    """Both catalog and sources.yml — catalog wins, manifest fills gaps."""

    def test_overlap_uses_catalog_type_and_manifest_description(self) -> None:
        catalog = _make_catalog([CatalogColumnInfo(name="event_id", type="VARCHAR", index=0)])
        source = _make_source(
            columns={
                "event_id": ManifestColumnInfo(
                    name="event_id", description="From sources.yml", data_type="text"
                )
            }
        )
        result = transform_source(source, catalog, None)
        assert len(result["columns"]) == 1
        col = result["columns"][0]
        assert col["data_type"] == "VARCHAR"  # catalog wins
        assert col["description"] == "From sources.yml"  # manifest description

    def test_manifest_only_columns_appended_after_catalog(self) -> None:
        catalog = _make_catalog(
            [
                CatalogColumnInfo(name="event_id", type="VARCHAR", index=0),
                CatalogColumnInfo(name="user_id", type="VARCHAR", index=1),
            ]
        )
        source = _make_source(
            columns={
                "event_id": ManifestColumnInfo(name="event_id"),
                "extra_col": ManifestColumnInfo(
                    name="extra_col", description="Manifest only", data_type="int"
                ),
            }
        )
        result = transform_source(source, catalog, None)
        names = [c["name"] for c in result["columns"]]
        assert names == ["event_id", "user_id", "extra_col"]
        extra = result["columns"][2]
        assert extra["description"] == "Manifest only"
        assert extra["data_type"] == "int"

    def test_case_insensitive_dedup_catalog_wins(self) -> None:
        catalog = _make_catalog([CatalogColumnInfo(name="EVENT_AT", type="TIMESTAMP", index=0)])
        source = _make_source(
            columns={
                "event_at": ManifestColumnInfo(
                    name="event_at", description="lower", data_type="text"
                )
            }
        )
        result = transform_source(source, catalog, None)
        assert len(result["columns"]) == 1
        col = result["columns"][0]
        assert col["name"] == "EVENT_AT"  # catalog casing
        assert col["data_type"] == "TIMESTAMP"
        assert col["description"] == "lower"  # manifest description still applies


class TestColumnTests:
    """Source column tests flow through from manifest test nodes."""

    def test_test_with_run_result_has_pass_status(self) -> None:
        source = _make_source(columns={"event_id": ManifestColumnInfo(name="event_id")})
        test_node = _make_test_node(name="not_null_events_event_id", column_name="event_id")
        run_results = {test_node.unique_id: RunResult(unique_id=test_node.unique_id, status="pass")}
        result = transform_source(
            source,
            Catalog(),
            None,
            test_nodes_by_id={SOURCE_UID: [test_node]},
            run_results_by_id=run_results,
        )
        tests = result["columns"][0]["tests"]
        assert len(tests) == 1
        assert tests[0]["test_type"] == "not_null"
        assert tests[0]["status"] == "pass"

    def test_test_without_run_result_has_not_run_status(self) -> None:
        source = _make_source(columns={"event_id": ManifestColumnInfo(name="event_id")})
        test_node = _make_test_node(
            name="unique_events_event_id", column_name="event_id", test_type="unique"
        )
        result = transform_source(
            source,
            Catalog(),
            None,
            test_nodes_by_id={SOURCE_UID: [test_node]},
            run_results_by_id={},
        )
        tests = result["columns"][0]["tests"]
        assert len(tests) == 1
        assert tests[0]["status"] == "not_run"

    def test_no_test_maps_yields_empty_tests(self) -> None:
        source = _make_source(columns={"event_id": ManifestColumnInfo(name="event_id")})
        result = transform_source(source, Catalog(), None)
        assert result["columns"][0]["tests"] == []
