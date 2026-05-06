"""Benchmark stage_extract_relationships against a synthetic dbt manifest.

Builds an in-memory Manifest with N models and ~N*rel_multiplier relationships
tests, then times `stage_extract_relationships(ctx)` across several iterations
and reports the median.

This benchmark is **advisory** — wall-clock budgets are unreliable on CI
runners, so the CI gate lives in
`tests/generator/test_stage_extract_relationships.py::TestPerfBudget`. Run
this script locally to confirm production scale (200 models / 500 rels)
fits under the 250ms target.

Usage:
    python scripts/bench_erd_extraction.py
    python scripts/bench_erd_extraction.py --models 200 --rel-multiplier 2.5
    python scripts/bench_erd_extraction.py --iterations 10
"""

from __future__ import annotations

import argparse
import statistics
import time

from docglow.artifacts.catalog import Catalog
from docglow.artifacts.loader import LoadedArtifacts
from docglow.artifacts.manifest import (
    Manifest,
    ManifestColumnInfo,
    ManifestNode,
    NodeConfig,
    TestMetadata,
)
from docglow.artifacts.run_results import RunResults
from docglow.generator.pipeline import (
    PipelineContext,
    stage_build_lookups,
    stage_extract_relationships,
    stage_transform_nodes,
)


def _model_node(unique_id: str, name: str) -> ManifestNode:
    """Synthetic model with `id` + `parent_id` columns."""
    return ManifestNode(
        unique_id=unique_id,
        name=name,
        resource_type="model",
        package_name="bench",
        columns={
            "id": ManifestColumnInfo(name="id"),
            "parent_id": ManifestColumnInfo(name="parent_id"),
        },
        config=NodeConfig(materialized="view"),
        original_file_path="",
        meta={},
    )


def _relationships_test(
    *,
    test_uid: str,
    parent_name: str,
    child_name: str,
    parent_field: str,
    child_column: str,
) -> ManifestNode:
    """Synthetic relationships test mirroring dbt's emitted shape."""
    return ManifestNode(
        unique_id=test_uid,
        name=(f"relationships_{child_name}_{child_column}__{parent_field}__ref_{parent_name}_"),
        resource_type="test",
        package_name="bench",
        column_name=child_column,
        config=NodeConfig(materialized="test"),
        test_metadata=TestMetadata(
            name="relationships",
            kwargs={
                "to": f"ref('{parent_name}')",
                "field": parent_field,
                "column_name": child_column,
            },
        ),
        refs=[
            {"name": parent_name, "package": None, "version": None},
            {"name": child_name, "package": None, "version": None},
        ],
    )


def build_synthetic_context(num_models: int, rel_multiplier: float) -> PipelineContext:
    """Build a fully-loaded PipelineContext with `num_models` models and
    approximately `num_models * rel_multiplier` relationships tests.
    """
    target_rels = int(num_models * rel_multiplier)
    nodes: list[ManifestNode] = [
        _model_node(f"model.bench.m{i}", f"m{i}") for i in range(num_models)
    ]

    # Primary relationships: each model.parent_id → previous model.id (chain/ring).
    for i in range(num_models):
        parent_idx = (i - 1) % num_models
        nodes.append(
            _relationships_test(
                test_uid=f"test.bench.rel_m{i}_parent",
                parent_name=f"m{parent_idx}",
                child_name=f"m{i}",
                parent_field="id",
                child_column="parent_id",
            )
        )

    # Secondary relationships to reach ~target_rels: extra edges to m0.
    extra_needed = max(0, target_rels - num_models)
    for k in range(extra_needed):
        i = (k % (num_models - 1)) + 1  # skip m0 itself
        nodes.append(
            _relationships_test(
                test_uid=f"test.bench.rel_m{i}_to_m0__{k}",
                parent_name="m0",
                child_name=f"m{i}",
                parent_field="id",
                child_column="id",
            )
        )

    manifest = Manifest()
    manifest.metadata.project_name = "bench"
    for n in nodes:
        manifest.nodes[n.unique_id] = n

    artifacts = LoadedArtifacts(
        manifest=manifest,
        catalog=Catalog(),
        run_results=RunResults(results=[]),
        source_freshness=None,
    )
    ctx = PipelineContext(artifacts=artifacts, enable_erd=True)
    stage_build_lookups(ctx)
    stage_transform_nodes(ctx)
    return ctx


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark stage_extract_relationships at scale.")
    parser.add_argument(
        "--models",
        type=int,
        default=200,
        help="Number of synthetic models (default: 200)",
    )
    parser.add_argument(
        "--rel-multiplier",
        type=float,
        default=2.5,
        help="Average relationships tests per model (default: 2.5 → ~500 total)",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=5,
        help="Number of timed iterations (default: 5)",
    )
    args = parser.parse_args()

    print(
        f"Building synthetic manifest: {args.models} models, "
        f"~{int(args.models * args.rel_multiplier)} relationships tests..."
    )
    t_setup = time.perf_counter()
    ctx = build_synthetic_context(args.models, args.rel_multiplier)
    setup_ms = (time.perf_counter() - t_setup) * 1000
    print(f"  Setup: {setup_ms:.1f}ms (excluded from timed iterations)")

    timings_ms: list[float] = []
    for i in range(args.iterations):
        ctx.relationships = []
        t0 = time.perf_counter()
        stage_extract_relationships(ctx)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        timings_ms.append(elapsed_ms)
        print(
            f"  iter {i + 1}: {elapsed_ms:7.2f}ms ({len(ctx.relationships)} relationships emitted)"
        )

    median_ms = statistics.median(timings_ms)
    min_ms = min(timings_ms)
    max_ms = max(timings_ms)
    target_ms = 250.0
    status = "PASS" if median_ms <= target_ms else "FAIL"

    print()
    print(f"Median: {median_ms:.2f}ms  (min {min_ms:.2f}ms / max {max_ms:.2f}ms)")
    print(f"Target: {target_ms:.0f}ms  -> {status}")


if __name__ == "__main__":
    main()
