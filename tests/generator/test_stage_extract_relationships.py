"""Tests for stage_extract_relationships (DOC-213 U3).

Test-first per the plan's execution note. Synthetic ManifestNode fixtures
exercise the gnarly cases (composite keys, seed-as-parent, self-referential,
missing parent column, multi-test, cross-package skip, inference + fallback,
run-results join). Jaffle-shop integration is the safety net.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from docglow.artifacts.catalog import Catalog
from docglow.artifacts.loader import load_artifacts
from docglow.artifacts.manifest import (
    Manifest,
    ManifestColumnInfo,
    ManifestNode,
    ManifestSource,
    NodeConfig,
)
from docglow.artifacts.manifest import TestMetadata as _TestMetadata  # avoid pytest collection
from docglow.artifacts.run_results import RunResult, RunResults
from docglow.generator.pipeline import (
    PipelineContext,
    stage_build_lookups,
    stage_extract_relationships,
    stage_transform_nodes,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _model_node(
    unique_id: str,
    name: str,
    *,
    package: str = "myproj",
    columns: dict[str, ManifestColumnInfo] | None = None,
    original_file_path: str = "",
    meta: dict[str, Any] | None = None,
) -> ManifestNode:
    return ManifestNode(
        unique_id=unique_id,
        name=name,
        resource_type="model",
        package_name=package,
        columns=columns or {},
        config=NodeConfig(materialized="view"),
        original_file_path=original_file_path,
        meta=meta or {},
    )


def _model_node_with_meta(
    unique_id: str,
    name: str,
    *,
    package: str = "myproj",
    columns_meta: dict[str, dict[str, Any]] | None = None,
    original_file_path: str = "",
    model_level_meta: dict[str, Any] | None = None,
) -> ManifestNode:
    """Build a model node where each column carries the given `meta` dict.

    `columns_meta` maps column-name → meta dict. The column object itself is
    constructed from name + meta. Use this to set up `meta.docglow.relationships`
    entries for U4 tests.
    """
    columns: dict[str, ManifestColumnInfo] = {}
    for col_name, col_meta in (columns_meta or {}).items():
        columns[col_name] = ManifestColumnInfo(name=col_name, meta=col_meta)
    return _model_node(
        unique_id,
        name,
        package=package,
        columns=columns,
        original_file_path=original_file_path,
        meta=model_level_meta,
    )


def _seed_node(unique_id: str, name: str, *, package: str = "myproj") -> ManifestNode:
    return ManifestNode(
        unique_id=unique_id,
        name=name,
        resource_type="seed",
        package_name=package,
    )


def _relationships_test(
    *,
    test_uid: str,
    parent_name: str,
    child_name: str,
    parent_field: str,
    child_column: str,
    parent_package: str | None = None,
    child_package: str | None = None,
    package: str = "myproj",
    severity: str = "ERROR",
) -> ManifestNode:
    """Build a synthetic relationships test node mirroring dbt's emitted shape."""
    config = NodeConfig(materialized="test")
    # Severity is in NodeConfig's extras (extra='allow')
    config_dict = config.model_dump(by_alias=True)
    config_dict["severity"] = severity
    config = NodeConfig.model_validate(config_dict)

    return ManifestNode(
        unique_id=test_uid,
        name=f"relationships_{child_name}_{child_column}__{parent_field}__ref_{parent_name}_",
        resource_type="test",
        package_name=package,
        column_name=child_column,
        config=config,
        test_metadata=_TestMetadata(
            name="relationships",
            kwargs={
                "to": f"ref('{parent_name}')",
                "field": parent_field,
                "column_name": child_column,
            },
        ),
        refs=[
            {"name": parent_name, "package": parent_package, "version": None},
            {"name": child_name, "package": child_package, "version": None},
        ],
    )


def _source_relationships_test(
    *,
    test_uid: str,
    source_schema: str,
    source_table: str,
    child_name: str,
    parent_field: str,
    child_column: str,
    package: str = "myproj",
) -> ManifestNode:
    """Build a relationships test where the parent is a source."""
    return ManifestNode(
        unique_id=test_uid,
        name=f"relationships_{child_name}_{child_column}__{parent_field}__source_{source_table}_",
        resource_type="test",
        package_name=package,
        column_name=child_column,
        config=NodeConfig(materialized="test"),
        test_metadata=_TestMetadata(
            name="relationships",
            kwargs={
                "to": f"source('{source_schema}', '{source_table}')",
                "field": parent_field,
                "column_name": child_column,
            },
        ),
        refs=[{"name": child_name, "package": None, "version": None}],
        sources=[[source_schema, source_table]],
    )


def _column_test(
    *, test_uid: str, model_name: str, column: str, kind: str, package: str = "myproj"
) -> ManifestNode:
    """Build a `unique` or `not_null` sibling test on a column."""
    return ManifestNode(
        unique_id=test_uid,
        name=f"{kind}_{model_name}_{column}",
        resource_type="test",
        package_name=package,
        column_name=column,
        config=NodeConfig(materialized="test"),
        test_metadata=_TestMetadata(name=kind, kwargs={"column_name": column}),
        refs=[{"name": model_name, "package": None, "version": None}],
    )


def _make_context(
    nodes: list[ManifestNode],
    sources: list[ManifestSource] | None = None,
    run_results: list[RunResult] | None = None,
    *,
    enable_erd: bool = True,
    project_name: str = "myproj",
) -> PipelineContext:
    """Build a fully-loaded PipelineContext from synthetic nodes."""
    manifest = Manifest()
    manifest.metadata.project_name = project_name
    for n in nodes:
        manifest.nodes[n.unique_id] = n
    for s in sources or []:
        manifest.sources[s.unique_id] = s

    rr = RunResults(results=run_results or [])

    from docglow.artifacts.loader import LoadedArtifacts

    artifacts = LoadedArtifacts(
        manifest=manifest,
        catalog=Catalog(),
        run_results=rr,
        source_freshness=None,
    )
    ctx = PipelineContext(artifacts=artifacts, enable_erd=enable_erd)
    stage_build_lookups(ctx)
    stage_transform_nodes(ctx)
    return ctx


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_single_relationships_test_emits_one_entry(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_oi_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        ctx = _make_context([orders, order_items, rel_test])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["from_unique_id"] == "model.myproj.order_items"
        assert rel["from_column"] == "order_id"
        assert rel["to_unique_id"] == "model.myproj.orders"
        assert rel["to_column"] == "order_id"
        assert rel["inference_source"] == "test"
        assert rel["test_unique_id"] == "test.myproj.rel_oi_orders"
        assert rel["is_synthetic"] is False
        assert rel["meta_file_path"] is None
        assert rel["label"] is None
        assert rel["kind"] == "inferred"
        assert rel["severity"] == "error"
        assert isinstance(rel["id"], str) and len(rel["id"]) == 12

    def test_status_normalized_from_run_results(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_oi_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        run_result = RunResult(unique_id="test.myproj.rel_oi_orders", status="success")
        ctx = _make_context([orders, order_items, rel_test], run_results=[run_result])

        stage_extract_relationships(ctx)

        assert ctx.relationships[0]["status"] == "pass"

    def test_status_defaults_to_not_run_when_no_run_result(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_oi_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        ctx = _make_context([orders, order_items, rel_test])

        stage_extract_relationships(ctx)

        assert ctx.relationships[0]["status"] == "not_run"

    def test_severity_warn_lowercased(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_oi_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
            severity="WARN",
        )
        ctx = _make_context([orders, order_items, rel_test])

        stage_extract_relationships(ctx)

        assert ctx.relationships[0]["severity"] == "warn"


# ---------------------------------------------------------------------------
# Inference (§5.3 truth table via stage)
# ---------------------------------------------------------------------------


class TestInference:
    def test_with_sibling_unique_on_parent_and_not_null_on_child(self) -> None:
        """Both siblings present → ('one_and_only_one', 'one_or_many')."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        unique_on_parent = _column_test(
            test_uid="test.myproj.unique_orders_id",
            model_name="orders",
            column="order_id",
            kind="unique",
        )
        not_null_on_child = _column_test(
            test_uid="test.myproj.notnull_oi_order_id",
            model_name="order_items",
            column="order_id",
            kind="not_null",
        )

        ctx = _make_context([orders, order_items, rel_test, unique_on_parent, not_null_on_child])
        stage_extract_relationships(ctx)

        rel = ctx.relationships[0]
        assert rel["child_endpoint"] == "one_and_only_one"
        assert rel["parent_endpoint"] == "one_or_many"

    def test_fallback_no_siblings(self) -> None:
        """No siblings → ('zero_or_one', 'zero_or_many') fallback row."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )

        ctx = _make_context([orders, order_items, rel_test])
        stage_extract_relationships(ctx)

        rel = ctx.relationships[0]
        assert rel["child_endpoint"] == "zero_or_one"
        assert rel["parent_endpoint"] == "zero_or_many"


# ---------------------------------------------------------------------------
# Edge cases (origin §7)
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_composite_keys_emit_independent_edges(self) -> None:
        """Case 1: relationships test on multiple columns → N edges, one per column."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={
                "order_id": ManifestColumnInfo(name="order_id"),
                "tenant_id": ManifestColumnInfo(name="tenant_id"),
            },
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={
                "order_id": ManifestColumnInfo(name="order_id"),
                "tenant_id": ManifestColumnInfo(name="tenant_id"),
            },
        )
        rel_a = _relationships_test(
            test_uid="test.myproj.rel_oi_orders_order_id",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        rel_b = _relationships_test(
            test_uid="test.myproj.rel_oi_orders_tenant_id",
            parent_name="orders",
            child_name="order_items",
            parent_field="tenant_id",
            child_column="tenant_id",
        )

        ctx = _make_context([orders, order_items, rel_a, rel_b])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 2
        cols = {(r["from_column"], r["to_column"]) for r in ctx.relationships}
        assert cols == {("order_id", "order_id"), ("tenant_id", "tenant_id")}

    def test_seed_as_parent_supported(self) -> None:
        """Case 3: relationships test pointing at a seed → entry emitted with seed unique_id."""
        country_codes = _seed_node("seed.myproj.country_codes", "country_codes")
        users = _model_node(
            "model.myproj.users",
            "users",
            columns={"country_code": ManifestColumnInfo(name="country_code")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel_users_country_codes",
            parent_name="country_codes",
            child_name="users",
            parent_field="code",
            child_column="country_code",
        )

        ctx = _make_context([country_codes, users, rel])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        assert ctx.relationships[0]["to_unique_id"] == "seed.myproj.country_codes"

    def test_self_referential_supported(self) -> None:
        """Case 4: employees.manager_id → employees.id is allowed."""
        employees = _model_node(
            "model.myproj.employees",
            "employees",
            columns={
                "id": ManifestColumnInfo(name="id"),
                "manager_id": ManifestColumnInfo(name="manager_id"),
            },
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel_self",
            parent_name="employees",
            child_name="employees",
            parent_field="id",
            child_column="manager_id",
        )

        ctx = _make_context([employees, rel])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        r = ctx.relationships[0]
        assert r["from_unique_id"] == "model.myproj.employees"
        assert r["to_unique_id"] == "model.myproj.employees"
        assert r["from_column"] == "manager_id"
        assert r["to_column"] == "id"

    def test_missing_parent_column_emits_with_flag_false(self) -> None:
        """Case 6: parent column absent in manifest → emit with parent_column_exists=False."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},  # no `pk_id`
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel_missing",
            parent_name="orders",
            child_name="order_items",
            parent_field="pk_id",  # this column doesn't exist on orders
            child_column="order_id",
        )

        ctx = _make_context([orders, order_items, rel])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        assert ctx.relationships[0]["to_column"] == "pk_id"
        assert ctx.relationships[0]["parent_column_exists"] is False

    def test_parent_column_exists_true_when_present(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )

        ctx = _make_context([orders, order_items, rel])
        stage_extract_relationships(ctx)

        assert ctx.relationships[0]["parent_column_exists"] is True

    def test_multiple_tests_same_column_different_parents_emit_independently(self) -> None:
        """Case 7: two relationships tests on same column → 2 entries, both emitted."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        archived_orders = _model_node(
            "model.myproj.archived_orders",
            "archived_orders",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_to_orders = _relationships_test(
            test_uid="test.myproj.rel_to_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="id",
            child_column="order_id",
        )
        rel_to_archived = _relationships_test(
            test_uid="test.myproj.rel_to_archived",
            parent_name="archived_orders",
            child_name="order_items",
            parent_field="id",
            child_column="order_id",
        )

        ctx = _make_context([orders, archived_orders, order_items, rel_to_orders, rel_to_archived])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 2
        targets = {r["to_unique_id"] for r in ctx.relationships}
        assert targets == {"model.myproj.orders", "model.myproj.archived_orders"}

    def test_cross_package_test_skipped(self) -> None:
        """Case 5: refs[*].package is not None → skip silently (debug log)."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        # parent_package set → cross-package
        rel = _relationships_test(
            test_uid="test.myproj.rel_xpkg",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
            parent_package="other_pkg",
        )

        ctx = _make_context([orders, order_items, rel])
        stage_extract_relationships(ctx)

        assert ctx.relationships == []

    def test_source_as_parent_supported(self) -> None:
        """`to: source('s', 't')` → emits entry with source unique_id as parent."""
        raw_orders_source = ManifestSource(
            unique_id="source.myproj.raw.orders",
            name="orders",
            source_name="raw",
            schema="raw",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _source_relationships_test(
            test_uid="test.myproj.rel_source",
            source_schema="raw",
            source_table="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )

        ctx = _make_context([order_items, rel], sources=[raw_orders_source])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        r = ctx.relationships[0]
        assert r["to_unique_id"] == "source.myproj.raw.orders"
        assert r["from_unique_id"] == "model.myproj.order_items"


# ---------------------------------------------------------------------------
# Stage gating + idempotency
# ---------------------------------------------------------------------------


class TestStageGating:
    def test_disabled_when_enable_erd_false(self) -> None:
        """The stage itself is gated at registration time, so calling it with
        enable_erd=False should still no-op the writes (defensive)."""
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )

        ctx = _make_context([orders, order_items, rel], enable_erd=False)
        # Even if the stage runs (e.g. called directly), it must remain a no-op.
        stage_extract_relationships(ctx)

        assert ctx.relationships == []

    def test_id_is_stable_across_runs(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )

        ctx_a = _make_context([orders, order_items, rel])
        ctx_b = _make_context([orders, order_items, rel])
        stage_extract_relationships(ctx_a)
        stage_extract_relationships(ctx_b)

        assert ctx_a.relationships[0]["id"] == ctx_b.relationships[0]["id"]


# ---------------------------------------------------------------------------
# Jaffle-shop integration
# ---------------------------------------------------------------------------


class TestJaffleShopIntegration:
    @pytest.fixture
    def jaffle_ctx(self) -> PipelineContext:
        artifacts = load_artifacts(Path("examples/jaffle-shop"))
        ctx = PipelineContext(artifacts=artifacts, enable_erd=True)
        stage_build_lookups(ctx)
        stage_transform_nodes(ctx)
        return ctx

    def test_extracts_three_known_relationships(self, jaffle_ctx: PipelineContext) -> None:
        stage_extract_relationships(jaffle_ctx)

        edges = {
            (r["from_unique_id"], r["from_column"], r["to_unique_id"], r["to_column"])
            for r in jaffle_ctx.relationships
        }
        # Verified from manifest during planning.
        expected = {
            (
                "model.jaffle_shop.order_items",
                "order_id",
                "model.jaffle_shop.orders",
                "order_id",
            ),
            (
                "model.jaffle_shop.orders",
                "customer_id",
                "model.jaffle_shop.stg_customers",
                "customer_id",
            ),
            (
                "model.jaffle_shop.stg_order_items",
                "order_id",
                "model.jaffle_shop.stg_orders",
                "order_id",
            ),
        }
        assert edges == expected

    def test_all_entries_have_test_inference_source(self, jaffle_ctx: PipelineContext) -> None:
        stage_extract_relationships(jaffle_ctx)
        assert all(r["inference_source"] == "test" for r in jaffle_ctx.relationships)
        assert all(r["is_synthetic"] is False for r in jaffle_ctx.relationships)

    def test_disable_flag_yields_empty_relationships(self) -> None:
        artifacts = load_artifacts(Path("examples/jaffle-shop"))
        ctx = PipelineContext(artifacts=artifacts, enable_erd=False)
        stage_build_lookups(ctx)
        stage_transform_nodes(ctx)
        stage_extract_relationships(ctx)
        assert ctx.relationships == []


# ---------------------------------------------------------------------------
# Meta walker (DOC-213 U4)
# ---------------------------------------------------------------------------


class TestMetaWalker:
    """meta.docglow.relationships emits one dict per declaration."""

    def test_single_meta_entry_emits_one_dict(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id"},
                        ]
                    }
                }
            },
            original_file_path="models/marts/orders.yml",
        )
        ctx = _make_context([customers, orders])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["inference_source"] == "meta"
        assert rel["status"] == "none"
        assert rel["from_unique_id"] == "model.myproj.orders"
        assert rel["from_column"] == "customer_id"
        assert rel["to_unique_id"] == "model.myproj.customers"
        assert rel["to_column"] == "id"
        assert rel["to_model_name"] == "customers"
        assert rel["test_unique_id"] is None
        assert rel["meta_file_path"] == "models/marts/orders.yml"
        assert rel["is_synthetic"] is False
        assert rel["severity"] == "warn"  # default
        assert rel["label"] is None
        assert rel["kind"] == "inferred"  # no kind specified
        assert rel["parent_column_exists"] is True
        assert isinstance(rel["id"], str) and len(rel["id"]) == 12

    def test_kind_many_to_many_overrides_endpoints(self) -> None:
        tags = _model_node(
            "model.myproj.tags",
            "tags",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        post_tags = _model_node_with_meta(
            "model.myproj.post_tags",
            "post_tags",
            columns_meta={
                "tag_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "tags", "field": "id", "kind": "many_to_many"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([tags, post_tags])

        stage_extract_relationships(ctx)

        rel = ctx.relationships[0]
        assert rel["child_endpoint"] == "one_or_many"
        assert rel["parent_endpoint"] == "one_or_many"
        assert rel["kind"] == "many_to_many"

    def test_no_kind_no_siblings_falls_back(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([customers, orders])

        stage_extract_relationships(ctx)

        rel = ctx.relationships[0]
        assert rel["child_endpoint"] == "zero_or_one"
        assert rel["parent_endpoint"] == "zero_or_many"

    def test_severity_default_warn(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "customers", "field": "id"}]}}
            },
        )
        ctx = _make_context([customers, orders])
        stage_extract_relationships(ctx)
        assert ctx.relationships[0]["severity"] == "warn"

    def test_severity_error_respected_and_lowercased(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "severity": "ERROR"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([customers, orders])
        stage_extract_relationships(ctx)
        assert ctx.relationships[0]["severity"] == "error"

    def test_label_passed_through(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {
                                "to": "customers",
                                "field": "id",
                                "label": "placed by",
                            },
                        ]
                    }
                }
            },
        )
        ctx = _make_context([customers, orders])
        stage_extract_relationships(ctx)
        assert ctx.relationships[0]["label"] == "placed by"

    def test_meta_uses_sibling_tests_for_inference(self) -> None:
        """Meta declarations should still benefit from sibling unique/not_null tests."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "customers", "field": "id"}]}}
            },
        )
        unique_on_customers = _column_test(
            test_uid="test.myproj.unique_customers_id",
            model_name="customers",
            column="id",
            kind="unique",
        )
        not_null_on_orders = _column_test(
            test_uid="test.myproj.notnull_orders_customer_id",
            model_name="orders",
            column="customer_id",
            kind="not_null",
        )

        ctx = _make_context([customers, orders, unique_on_customers, not_null_on_orders])
        stage_extract_relationships(ctx)

        rel = ctx.relationships[0]
        assert rel["child_endpoint"] == "one_and_only_one"
        assert rel["parent_endpoint"] == "one_or_many"


class TestMetaWalkerEdgeCases:
    """Edge cases per origin §7 (cases 8, 11, 12) + structural malformations."""

    def test_ghost_edge_to_nonexistent_model(self, caplog: pytest.LogCaptureFixture) -> None:
        """Case 8: meta points at a model that doesn't exist."""
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "nonexistent_model", "field": "id"},
                        ]
                    }
                }
            },
            original_file_path="models/marts/orders.yml",
        )
        ctx = _make_context([orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["to_unique_id"] == ""
        assert rel["to_model_name"] == "nonexistent_model"
        assert rel["parent_column_exists"] is False
        # A warning was logged identifying the file.
        assert any("nonexistent_model" in r.getMessage() for r in caplog.records)

    def test_duplicate_entries_last_wins(self, caplog: pytest.LogCaptureFixture) -> None:
        """Case 11: two entries on same column with same (to,field) — last wins."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "kind": "one_to_one"},
                            {"to": "customers", "field": "id", "kind": "many_to_many"},
                        ]
                    }
                }
            },
            original_file_path="models/marts/orders.yml",
        )
        ctx = _make_context([customers, orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        # Only one entry (last-wins).
        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["kind"] == "many_to_many"
        # Warning was emitted.
        assert any(
            "models/marts/orders.yml" in r.getMessage() or "duplicate" in r.getMessage().lower()
            for r in caplog.records
        )

    def test_model_level_meta_ignored(self, caplog: pytest.LogCaptureFixture) -> None:
        """Open Question 2: model-level meta.docglow.relationships → ignored."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={"customer_id": {}},
            model_level_meta={
                "docglow": {
                    "relationships": [
                        {"to": "customers", "field": "id"},
                    ]
                }
            },
        )
        ctx = _make_context([customers, orders])

        with caplog.at_level("DEBUG", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        # Nothing emitted from model-level meta — and nothing crashed.
        assert ctx.relationships == []

    def test_non_list_relationships_value_skipped(self, caplog: pytest.LogCaptureFixture) -> None:
        """`relationships: 'customers'` (str instead of list) → warn, skip."""
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {"relationships": "customers"},  # not a list
                }
            },
            original_file_path="models/marts/orders.yml",
        )
        ctx = _make_context([orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        assert ctx.relationships == []
        assert any(
            "list" in r.getMessage().lower() or "customer_id" in r.getMessage()
            for r in caplog.records
        )

    def test_missing_required_to_field_skipped(self, caplog: pytest.LogCaptureFixture) -> None:
        """Meta entry missing `to` → skipped with warning."""
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"field": "id"},  # no `to`
                        ]
                    }
                }
            },
        )
        ctx = _make_context([orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        assert ctx.relationships == []
        assert any(caplog.records)

    def test_missing_required_field_skipped(self, caplog: pytest.LogCaptureFixture) -> None:
        """Meta entry missing `field` → skipped with warning."""
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers"},  # no `field`
                        ]
                    }
                }
            },
        )
        ctx = _make_context([orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        assert ctx.relationships == []
        assert any(caplog.records)

    def test_unknown_kind_falls_back_to_inferred(self) -> None:
        """Unknown `kind` value logs warning + uses inferred endpoints."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "kind": "bogus_kind"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([customers, orders])
        stage_extract_relationships(ctx)
        rel = ctx.relationships[0]
        # Falls back to inferred endpoints when kind is unrecognized.
        assert rel["child_endpoint"] == "zero_or_one"
        assert rel["parent_endpoint"] == "zero_or_many"
        assert rel["kind"] == "inferred"


class TestNonOverlappingTestAndMeta:
    """U5: test + meta entries on different (from, to) keys both appear."""

    def test_test_entries_and_meta_entries_both_appear(self) -> None:
        # Test-walker entry: order_items.order_id → orders.order_id
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_oi_orders",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        # Meta-walker entry: orders.customer_id → customers.id
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        # Replace `orders` with one that ALSO has meta on customer_id, since
        # the original `orders` only has `order_id`. Use a separate model to
        # avoid interfering with the test entry.
        sales = _model_node_with_meta(
            "model.myproj.sales",
            "sales",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "customers", "field": "id"}]}}
            },
        )

        ctx = _make_context([orders, order_items, rel_test, customers, sales])
        stage_extract_relationships(ctx)

        # Naive concat: 1 test entry + 1 meta entry.
        assert len(ctx.relationships) == 2
        sources = [r["inference_source"] for r in ctx.relationships]
        assert sources.count("test") == 1
        assert sources.count("meta") == 1


# ---------------------------------------------------------------------------
# Composition (DOC-213 U5)
# ---------------------------------------------------------------------------


class TestComposition:
    """`_compose` merges test + meta entries with conflict rules + dedupe."""

    def test_test_alone_emits_test_source(self) -> None:
        orders = _model_node(
            "model.myproj.orders",
            "orders",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        order_items = _model_node(
            "model.myproj.order_items",
            "order_items",
            columns={"order_id": ManifestColumnInfo(name="order_id")},
        )
        rel = _relationships_test(
            test_uid="test.myproj.rel",
            parent_name="orders",
            child_name="order_items",
            parent_field="order_id",
            child_column="order_id",
        )
        ctx = _make_context([orders, order_items, rel])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        assert ctx.relationships[0]["inference_source"] == "test"

    def test_meta_alone_emits_meta_source(self) -> None:
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "customers", "field": "id"}]}}
            },
        )
        ctx = _make_context([customers, orders])
        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        assert ctx.relationships[0]["inference_source"] == "meta"

    def test_test_plus_meta_same_4tuple_merges_into_both(self) -> None:
        """Test + meta on the same (from_uid, from_col, to_uid, to_col) → single 'both' entry.

        Per the plan + U4-handoff resolutions:
          - label adopted from meta (test entries always have label=None)
          - status preserved from test (meta entries always have status="none")
          - id recomputed via relationship_id(..., "both") so it differs from
            either single-source contributor.
        """
        from docglow.generator.erd import relationship_id

        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "label": "placed by"},
                        ]
                    }
                }
            },
            original_file_path="models/marts/orders.yml",
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_orders_customers",
            parent_name="customers",
            child_name="orders",
            parent_field="id",
            child_column="customer_id",
        )
        run_result = RunResult(unique_id="test.myproj.rel_orders_customers", status="success")
        ctx = _make_context([customers, orders, rel_test], run_results=[run_result])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["inference_source"] == "both"
        # Test wins: status, severity, test_unique_id.
        assert rel["status"] == "pass"
        assert rel["severity"] == "error"
        assert rel["test_unique_id"] == "test.myproj.rel_orders_customers"
        # Meta contributes: label, meta_file_path.
        assert rel["label"] == "placed by"
        assert rel["meta_file_path"] == "models/marts/orders.yml"
        # id recomputed with source="both" — distinct from either contributor.
        expected_both_id = relationship_id(
            "model.myproj.orders", "customer_id", "model.myproj.customers", "id", "both"
        )
        test_only_id = relationship_id(
            "model.myproj.orders", "customer_id", "model.myproj.customers", "id", "test"
        )
        meta_only_id = relationship_id(
            "model.myproj.orders", "customer_id", "model.myproj.customers", "id", "meta"
        )
        assert rel["id"] == expected_both_id
        assert rel["id"] != test_only_id
        assert rel["id"] != meta_only_id

    def test_severity_precedence_test_wins_on_merge(self) -> None:
        """test severity=error + meta severity=warn → merged severity = 'error'."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "severity": "warn"},
                        ]
                    }
                }
            },
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_orders_customers",
            parent_name="customers",
            child_name="orders",
            parent_field="id",
            child_column="customer_id",
            severity="ERROR",
        )
        ctx = _make_context([customers, orders, rel_test])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        assert ctx.relationships[0]["inference_source"] == "both"
        assert ctx.relationships[0]["severity"] == "error"

    def test_kind_handoff_meta_kind_overrides_endpoints_on_merge(self) -> None:
        """test kind=inferred + meta kind=many_to_many → merged kind=many_to_many.

        Endpoints must reflect the meta override (one_or_many / one_or_many)
        even though the test entry was emitted with `inferred` semantics.
        """
        tags = _model_node(
            "model.myproj.tags",
            "tags",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        post_tags = _model_node_with_meta(
            "model.myproj.post_tags",
            "post_tags",
            columns_meta={
                "tag_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "tags", "field": "id", "kind": "many_to_many"},
                        ]
                    }
                }
            },
        )
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_pt_tags",
            parent_name="tags",
            child_name="post_tags",
            parent_field="id",
            child_column="tag_id",
        )
        ctx = _make_context([tags, post_tags, rel_test])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        rel = ctx.relationships[0]
        assert rel["inference_source"] == "both"
        assert rel["kind"] == "many_to_many"
        assert rel["child_endpoint"] == "one_or_many"
        assert rel["parent_endpoint"] == "one_or_many"

    def test_conflict_on_to_column_emits_both_with_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """test says (customers, customer_id), meta says (customers, id) →
        2 entries (different keys), warning logged naming both file paths."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={
                "id": ManifestColumnInfo(name="id"),
                "customer_id": ManifestColumnInfo(name="customer_id"),
            },
        )
        # Meta says parent column is `id`.
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "customers", "field": "id"}]}}
            },
            original_file_path="models/marts/orders.yml",
        )
        # Test says parent column is `customer_id`.
        rel_test = _relationships_test(
            test_uid="test.myproj.rel_orders_customers",
            parent_name="customers",
            child_name="orders",
            parent_field="customer_id",
            child_column="customer_id",
        )
        ctx = _make_context([customers, orders, rel_test])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        # Both surfaced — different keys.
        assert len(ctx.relationships) == 2
        sources = sorted(r["inference_source"] for r in ctx.relationships)
        assert sources == ["meta", "test"]
        # Warning identifies the conflict.
        warning_msgs = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
        assert any("conflict" in m.lower() or "models/marts/orders.yml" in m for m in warning_msgs)

    def test_duplicate_meta_entries_within_column_survive_composition(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Case 11: U4 last-wins gives us one entry; composition must not collapse it further."""
        customers = _model_node(
            "model.myproj.customers",
            "customers",
            columns={"id": ManifestColumnInfo(name="id")},
        )
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "customers", "field": "id", "kind": "one_to_one"},
                            {"to": "customers", "field": "id", "kind": "many_to_many"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([customers, orders])

        with caplog.at_level("WARNING", logger="docglow.generator.erd"):
            stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 1
        # Last-wins from U4 preserved through compose.
        assert ctx.relationships[0]["kind"] == "many_to_many"

    def test_ghost_edges_to_distinct_models_preserved(self) -> None:
        """Two ghost edges from same column to two different nonexistent models → 2 entries."""
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {
                    "docglow": {
                        "relationships": [
                            {"to": "missing_a", "field": "id"},
                            {"to": "missing_b", "field": "id"},
                        ]
                    }
                }
            },
        )
        ctx = _make_context([orders])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 2
        ghost_targets = {r["to_model_name"] for r in ctx.relationships}
        assert ghost_targets == {"missing_a", "missing_b"}
        # Both ghost edges share to_unique_id="" but were not collapsed.
        assert all(r["to_unique_id"] == "" for r in ctx.relationships)

    def test_ghost_edges_from_different_columns_to_same_missing_model_preserved(self) -> None:
        """Two ghost edges from different child columns to the same nonexistent model → 2 entries.

        Key includes to_model_name + child column, so both survive composition.
        """
        orders = _model_node_with_meta(
            "model.myproj.orders",
            "orders",
            columns_meta={
                "customer_id": {"docglow": {"relationships": [{"to": "missing_x", "field": "id"}]}},
                "shipper_id": {"docglow": {"relationships": [{"to": "missing_x", "field": "id"}]}},
            },
        )
        ctx = _make_context([orders])

        stage_extract_relationships(ctx)

        assert len(ctx.relationships) == 2
        from_cols = {r["from_column"] for r in ctx.relationships}
        assert from_cols == {"customer_id", "shipper_id"}
        assert all(r["to_model_name"] == "missing_x" for r in ctx.relationships)

    def test_deterministic_ordering_across_runs(self) -> None:
        """Same input twice → identical dict lists in identical order."""

        def build_nodes() -> list[ManifestNode]:
            customers = _model_node(
                "model.myproj.customers",
                "customers",
                columns={"id": ManifestColumnInfo(name="id")},
            )
            orders = _model_node(
                "model.myproj.orders",
                "orders",
                columns={"order_id": ManifestColumnInfo(name="order_id")},
            )
            order_items = _model_node_with_meta(
                "model.myproj.order_items",
                "order_items",
                columns_meta={
                    "customer_id": {
                        "docglow": {"relationships": [{"to": "customers", "field": "id"}]}
                    }
                },
            )
            rel_test = _relationships_test(
                test_uid="test.myproj.rel_oi_orders",
                parent_name="orders",
                child_name="order_items",
                parent_field="order_id",
                child_column="order_id",
            )
            return [customers, orders, order_items, rel_test]

        ctx_a = _make_context(build_nodes())
        ctx_b = _make_context(build_nodes())
        stage_extract_relationships(ctx_a)
        stage_extract_relationships(ctx_b)

        assert ctx_a.relationships == ctx_b.relationships


# Quiet linter: `Any` is used in helper signatures
_ = Any
