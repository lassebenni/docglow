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
    return test_map


def normalize_test_status(status: str) -> str:
    """Normalize dbt test status to our standard values."""
    return _TEST_STATUS_MAP.get(status.lower(), status)


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
