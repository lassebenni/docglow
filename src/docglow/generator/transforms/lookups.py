"""Build lookup maps from dbt artifacts for efficient cross-referencing."""

from __future__ import annotations

from typing import Any

from docglow.artifacts.manifest import Manifest, ManifestNode
from docglow.artifacts.run_results import RunResult, RunResults

_TEST_STATUS_MAP = {
    "success": "pass",
    "pass": "pass",
    "fail": "fail",
    "failure": "fail",
    "error": "error",
    "warn": "warn",
    "warning": "warn",
    "skipped": "not_run",
}


def build_run_results_map(
    run_results: RunResults | None,
) -> dict[str, RunResult]:
    """Map unique_id -> RunResult for quick lookup."""
    if run_results is None:
        return {}
    return {r.unique_id: r for r in run_results.results}


def build_test_map(
    manifest: Manifest,
) -> dict[str, list[ManifestNode]]:
    """Map model unique_id -> list of test nodes that depend on it."""
    test_map: dict[str, list[ManifestNode]] = {}
    for node in manifest.nodes.values():
        if node.resource_type != "test":
            continue
        for dep_id in node.depends_on.nodes:
            if dep_id not in test_map:
                test_map[dep_id] = []
            test_map[dep_id].append(node)

    # dbt 1.8+ unit tests live on manifest.unit_tests (not manifest.nodes); the
    # Manifest model exposes them via pydantic extras when the field is unknown.
    unit_tests_raw = getattr(manifest, "unit_tests", None)
    if unit_tests_raw is None and getattr(manifest, "__pydantic_extra__", None):
        unit_tests_raw = manifest.__pydantic_extra__.get("unit_tests")
    if unit_tests_raw:
        for ut_data in unit_tests_raw.values():
            ut_node = ManifestNode.model_validate(ut_data)
            for dep_id in ut_node.depends_on.nodes:
                if dep_id not in test_map:
                    test_map[dep_id] = []
                test_map[dep_id].append(ut_node)
    return test_map


def normalize_test_status(status: str) -> str:
    """Normalize dbt test status to our standard values."""
    return _TEST_STATUS_MAP.get(status.lower(), status)


def test_type_from_node(test_node: ManifestNode) -> str:
    """Return the dbt generic test name, or ``unit_test`` for unit tests."""
    if test_node.test_metadata:
        return test_node.test_metadata.name
    if test_node.resource_type == "unit_test":
        return "unit_test"
    return ""


def test_sql_fields(
    test_node: ManifestNode,
    run_result: RunResult | None,
) -> dict[str, str | None]:
    """Return compiled and raw SQL for a dbt test node.

    Prefer run_results compiled SQL (post-run), then manifest compiled_code,
    then raw Jinja source as a last resort.
    """
    compiled: str | None = None
    raw = (test_node.raw_code or "").strip() or None
    if run_result and run_result.compiled_code:
        compiled = run_result.compiled_code.strip() or None
    elif test_node.compiled_code:
        compiled = test_node.compiled_code.strip() or None
    return {"compiled_sql": compiled, "raw_sql": raw}


def build_column_tests(
    unique_id: str,
    test_nodes_by_id: dict[str, list[ManifestNode]],
    run_results_by_id: dict[str, RunResult],
) -> dict[str, list[dict[str, Any]]]:
    """Build a map of column_name -> list of test dicts for a model or source."""
    column_tests: dict[str, list[dict[str, Any]]] = {}

    for test_node in test_nodes_by_id.get(unique_id, []):
        if not test_node.column_name:
            continue

        col_lower = test_node.column_name.lower()
        test_type = ""
        if test_node.test_metadata:
            test_type = test_node.test_metadata.name

        result = run_results_by_id.get(test_node.unique_id)
        status = "not_run"
        if result:
            status = normalize_test_status(result.status)

        test_entry: dict[str, Any] = {
            "test_name": test_node.name,
            "test_type": test_type,
            "status": status,
            "config": {},
        }

        if test_node.test_metadata and test_type == "accepted_values":
            kwargs = test_node.test_metadata.kwargs
            test_entry["config"] = {"values": kwargs.get("values", [])}

        if col_lower not in column_tests:
            column_tests[col_lower] = []
        column_tests[col_lower].append(test_entry)

    return column_tests


def build_reverse_dependency_map(manifest: Manifest) -> dict[str, list[str]]:
    """Build a map of unique_id -> list of unique_ids that depend on it."""
    if manifest.child_map:
        return dict(manifest.child_map)

    reverse: dict[str, list[str]] = {}
    for unique_id, node in manifest.nodes.items():
        if node.resource_type in ("test", "operation"):
            continue
        for dep_id in node.depends_on.nodes:
            if dep_id not in reverse:
                reverse[dep_id] = []
            reverse[dep_id].append(unique_id)
    return reverse
