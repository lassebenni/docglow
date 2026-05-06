"""Pure helpers for stage_extract_relationships (DOC-213).

Crow's-foot inference + meta.kind override + stable relationship id, plus
worker functions used by the pipeline stage to walk dbt `relationships`
tests and emit ErdRelationship-shaped dicts.

No I/O. Functions in this module are referentially transparent — they take
the parsed Manifest (and supporting indices) and return data.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from docglow.artifacts.manifest import Manifest, ManifestNode
from docglow.artifacts.run_results import RunResult
from docglow.generator.transforms.models import normalize_test_status

logger = logging.getLogger(__name__)

# Endpoint glyph names. Match the §5.3 inference table verbatim so frontend
# consumers can branch on the strings without a translation layer.
ONE_AND_ONLY_ONE = "one_and_only_one"  # ||
ZERO_OR_ONE = "zero_or_one"  # o|
ONE_OR_MANY = "one_or_many"  # }|
ZERO_OR_MANY = "zero_or_many"  # }o


def infer_endpoints(child_not_null: bool, parent_unique: bool) -> tuple[str, str]:
    """Infer (child_endpoint, parent_endpoint) from sibling test presence.

    Implements the §5.3 truth table:

    | child not_null? | parent unique? | child         | parent         |
    |-----------------|----------------|---------------|----------------|
    | yes             | yes            | one_and_only_one | one_or_many |
    | yes             | no             | one_and_only_one | zero_or_many|
    | no              | yes            | zero_or_one      | one_or_many |
    | no              | no             | zero_or_one      | zero_or_many|  ← fallback
    """
    child = ONE_AND_ONLY_ONE if child_not_null else ZERO_OR_ONE
    parent = ONE_OR_MANY if parent_unique else ZERO_OR_MANY
    return child, parent


def apply_meta_kind_override(
    child_endpoint: str,
    parent_endpoint: str,
    kind: str | None,
) -> tuple[str, str]:
    """Hard-override inferred endpoints when meta.docglow.relationships specifies kind.

    Per origin §5.3 special cases:
      - one_to_one   → both sides ||
      - one_to_many  → child ||, parent }|
      - many_to_many → both sides }|

    None or any unrecognized value passes the inputs through unchanged. The
    caller is responsible for warning on conflicts (origin §5.4).
    """
    if kind == "one_to_one":
        return ONE_AND_ONLY_ONE, ONE_AND_ONLY_ONE
    if kind == "one_to_many":
        return ONE_AND_ONLY_ONE, ONE_OR_MANY
    if kind == "many_to_many":
        return ONE_OR_MANY, ONE_OR_MANY
    return child_endpoint, parent_endpoint


def relationship_id(
    from_uid: str,
    from_col: str,
    to_uid: str,
    to_col: str,
    source: str,
) -> str:
    """Stable 12-char id for a relationship dict.

    Hashes the pipe-joined tuple so equal inputs always yield equal ids and
    any single-field change yields a different id. The explicit join is
    intentional — repr/str(tuple) representations vary across Python versions.
    """
    payload = "|".join([from_uid, from_col, to_uid, to_col, source]).encode("utf-8")
    return hashlib.sha1(payload).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Worker helpers for stage_extract_relationships (DOC-213 U3)
# ---------------------------------------------------------------------------


def _build_parent_lookup(manifest: Manifest) -> dict[str, str]:
    """Map simple node name → unique_id across models / seeds / snapshots / sources.

    Sources are keyed by table name (`source.name`); on the rare collision
    between two sources sharing a table name (e.g. `raw.orders` and
    `staging.orders`), last-wins is acceptable for v1 — multi-source disambiguation
    is a v1.1 concern.
    """
    lookup: dict[str, str] = {}
    for uid, node in manifest.nodes.items():
        if node.resource_type in ("model", "seed", "snapshot"):
            lookup[node.name] = uid
    for uid, source in manifest.sources.items():
        lookup[source.name] = uid
    return lookup


def _build_test_index(manifest: Manifest) -> dict[tuple[str, str], set[str]]:
    """Map (model_unique_id, column_name_lower) → set of test type names.

    A relationships test on a column also depends on whether the column has
    sibling `unique` / `not_null` tests; this index makes both lookups O(1).
    """
    index: dict[tuple[str, str], set[str]] = {}
    for node in manifest.nodes.values():
        if node.resource_type != "test":
            continue
        if not node.test_metadata or not node.column_name:
            continue
        # The model under test is the *last* ref for built-in tests; for
        # generic single-arg tests like `unique` / `not_null` it is the only ref.
        refs = node.refs
        if not refs:
            continue
        last_ref = refs[-1]
        ref_name = _ref_name(last_ref)
        if ref_name is None:
            continue
        # Look up the model unique_id by simple name across all node types.
        for uid, candidate in manifest.nodes.items():
            if (
                candidate.resource_type in ("model", "seed", "snapshot")
                and candidate.name == ref_name
            ):
                key = (uid, node.column_name.lower())
                index.setdefault(key, set()).add(node.test_metadata.name)
                break
        else:
            # Could be a source — sources don't typically take unique/not_null
            # tests in this lookup, but be permissive.
            for uid, source in manifest.sources.items():
                if source.name == ref_name:
                    key = (uid, node.column_name.lower())
                    index.setdefault(key, set()).add(node.test_metadata.name)
                    break
    return index


def _build_columns_index(manifest: Manifest) -> dict[str, set[str]]:
    """Map unique_id → set of lowercased column names declared in the manifest.

    Used to populate `parent_column_exists` on each relationship dict so the
    inspector can warn when a `relationships` test references a column the
    parent model doesn't declare (origin §7 case 6).
    """
    columns: dict[str, set[str]] = {}
    for uid, node in manifest.nodes.items():
        if node.resource_type in ("model", "seed", "snapshot"):
            columns[uid] = {c.lower() for c in node.columns}
    for uid, source in manifest.sources.items():
        columns[uid] = {c.lower() for c in source.columns}
    return columns


def _ref_name(ref: Any) -> str | None:
    """Extract the simple name from a manifest ref entry.

    dbt emits refs as dicts (`{"name": ..., "package": ..., "version": ...}`).
    Older manifests may emit a list `[name]` or `[package, name]`. Be permissive.
    """
    if isinstance(ref, dict):
        name = ref.get("name")
        return str(name) if name else None
    if isinstance(ref, list | tuple):
        if len(ref) == 1:
            return str(ref[0])
        if len(ref) >= 2:
            return str(ref[-1])
    return None


def _ref_package(ref: Any) -> str | None:
    """Extract the package name from a manifest ref entry, or None."""
    if isinstance(ref, dict):
        pkg = ref.get("package")
        return str(pkg) if pkg else None
    return None


def _extract_from_test(
    test_node: ManifestNode,
    parent_lookup: dict[str, str],
    test_index: dict[tuple[str, str], set[str]],
    columns_by_uid: dict[str, set[str]],
    run_results_by_id: dict[str, RunResult],
) -> dict[str, Any] | None:
    """Build one ErdRelationship-shaped dict from a `relationships` test node.

    Returns None on cross-package, malformed, or otherwise unsupported tests
    (logged at debug level — these are real-and-common scenarios, not warnings).
    """
    metadata = test_node.test_metadata
    if metadata is None or metadata.name != "relationships":
        return None

    if metadata.namespace is not None:
        logger.debug(
            "skipping non-builtin relationships test %s (namespace=%s)",
            test_node.unique_id,
            metadata.namespace,
        )
        return None

    child_column = test_node.column_name or ""
    parent_field = metadata.kwargs.get("field") if metadata.kwargs else None
    if not child_column or not parent_field:
        logger.debug(
            "skipping relationships test %s with missing column_name or field",
            test_node.unique_id,
        )
        return None
    parent_field_str = str(parent_field)

    refs = list(test_node.refs)
    sources = list(test_node.sources)

    # Resolve parent and child unique_ids.
    parent_uid: str | None = None
    parent_name: str | None = None
    child_uid: str | None = None

    if sources:
        # to: source(...) — sources[0] is [schema, table]; refs has only the child.
        first_source = sources[0]
        if isinstance(first_source, list | tuple) and len(first_source) >= 2:
            parent_name = str(first_source[1])
            parent_uid = parent_lookup.get(parent_name)
        if not refs:
            logger.debug(
                "skipping source-as-parent test %s with no child ref",
                test_node.unique_id,
            )
            return None
        child_ref = refs[-1]
        if _ref_package(child_ref) is not None:
            logger.debug("skipping cross-package test %s", test_node.unique_id)
            return None
        child_name = _ref_name(child_ref)
        if child_name is None:
            return None
        child_uid = parent_lookup.get(child_name)
    else:
        if len(refs) < 2:
            logger.debug(
                "skipping relationships test %s with refs=%s (expected parent+child)",
                test_node.unique_id,
                refs,
            )
            return None
        parent_ref, child_ref = refs[0], refs[1]
        if _ref_package(parent_ref) is not None or _ref_package(child_ref) is not None:
            logger.debug("skipping cross-package test %s", test_node.unique_id)
            return None
        parent_name = _ref_name(parent_ref)
        child_name = _ref_name(child_ref)
        if parent_name is None or child_name is None:
            return None
        parent_uid = parent_lookup.get(parent_name)
        child_uid = parent_lookup.get(child_name)

    if not parent_uid or not child_uid:
        logger.debug(
            "skipping test %s — could not resolve parent=%s or child=%s",
            test_node.unique_id,
            parent_name,
            (refs[-1] if refs else None),
        )
        return None

    # Inference: sibling tests on parent column / child column.
    parent_col_lower = parent_field_str.lower()
    child_col_lower = child_column.lower()
    parent_unique = "unique" in test_index.get((parent_uid, parent_col_lower), set())
    child_not_null = "not_null" in test_index.get((child_uid, child_col_lower), set())
    child_endpoint, parent_endpoint = infer_endpoints(child_not_null, parent_unique)

    # Run results join.
    run_result = run_results_by_id.get(test_node.unique_id)
    status = "not_run"
    if run_result:
        status = normalize_test_status(run_result.status)

    # Severity from config (uppercase in dbt output → lowercase normalized).
    severity_raw = getattr(test_node.config, "severity", None) or "error"
    severity = str(severity_raw).lower()

    parent_column_exists = parent_col_lower in columns_by_uid.get(parent_uid, set())

    return {
        "id": relationship_id(child_uid, child_column, parent_uid, parent_field_str, "test"),
        "from_unique_id": child_uid,
        "from_column": child_column,
        "to_unique_id": parent_uid,
        "to_column": parent_field_str,
        "to_model_name": parent_name or "",
        "kind": "inferred",
        "child_endpoint": child_endpoint,
        "parent_endpoint": parent_endpoint,
        "inference_source": "test",
        "severity": severity,
        "status": status,
        "label": None,
        "test_unique_id": test_node.unique_id,
        "meta_file_path": None,
        "is_synthetic": False,
        "parent_column_exists": parent_column_exists,
    }
