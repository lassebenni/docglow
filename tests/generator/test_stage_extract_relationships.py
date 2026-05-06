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
) -> ManifestNode:
    return ManifestNode(
        unique_id=unique_id,
        name=name,
        resource_type="model",
        package_name=package,
        columns=columns or {},
        config=NodeConfig(materialized="view"),
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


# Quiet linter: `Any` is used in helper signatures
_ = Any
