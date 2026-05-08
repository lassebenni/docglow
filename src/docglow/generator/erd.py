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
from collections import Counter, defaultdict
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

    `dbt_constraints.primary_key` and `dbt_constraints.unique_key` are aliased
    to `unique` so cardinality inference downstream treats a column with a
    dbt_constraints PK/UK exactly like one with a built-in `unique` test.
    This benefits both built-in `relationships` tests and dbt_constraints
    `foreign_key` tests — projects that use the dbt_constraints package get
    the same parent-side cardinality refinement automatically.
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

        # Alias dbt_constraints.primary_key / unique_key to "unique" so that
        # cardinality inference picks them up alongside built-in unique tests.
        test_name = node.test_metadata.name
        if node.test_metadata.namespace == "dbt_constraints" and test_name in (
            "primary_key",
            "unique_key",
        ):
            test_name = "unique"

        # Look up the model unique_id by simple name across all node types.
        for uid, candidate in manifest.nodes.items():
            if (
                candidate.resource_type in ("model", "seed", "snapshot")
                and candidate.name == ref_name
            ):
                key = (uid, node.column_name.lower())
                index.setdefault(key, set()).add(test_name)
                break
        else:
            # Could be a source — sources don't typically take unique/not_null
            # tests in this lookup, but be permissive.
            for uid, source in manifest.sources.items():
                if source.name == ref_name:
                    key = (uid, node.column_name.lower())
                    index.setdefault(key, set()).add(test_name)
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


def _extract_from_dbt_constraints_fk(
    test_node: ManifestNode,
    parent_lookup: dict[str, str],
    test_index: dict[tuple[str, str], set[str]],
    columns_by_uid: dict[str, set[str]],
    run_results_by_id: dict[str, RunResult],
) -> dict[str, Any] | None:
    """Build one ErdRelationship-shaped dict from a `dbt_constraints.foreign_key` test.

    Single-column FKs only — model-level (composite) FKs declared via
    `fk_column_names` / `pk_column_names` are debug-logged and skipped.

    Mirrors the output shape of `_extract_from_test` and returns the same
    `inference_source='test'` bucket; the originating test type is preserved
    on the `test_unique_id` field for downstream consumers that need to
    distinguish.

    Returns None on cross-package, malformed, composite, or otherwise
    unsupported tests (logged at debug level).
    """
    metadata = test_node.test_metadata
    if metadata is None:
        return None
    if metadata.namespace != "dbt_constraints" or metadata.name != "foreign_key":
        return None

    kwargs = metadata.kwargs or {}

    # Composite FK detection — column-level only is supported for v1.
    if "fk_column_names" in kwargs or "pk_column_names" in kwargs:
        logger.debug(
            "skipping composite dbt_constraints.foreign_key test %s "
            "(multi-column FKs not supported)",
            test_node.unique_id,
        )
        return None

    child_column = test_node.column_name or ""
    if not child_column:
        # Model-level test without a column_name is treated as composite/unsupported.
        logger.debug(
            "skipping model-level dbt_constraints.foreign_key test %s (no column_name)",
            test_node.unique_id,
        )
        return None

    pk_column_name = kwargs.get("pk_column_name")
    pk_table_name = kwargs.get("pk_table_name")
    if not pk_column_name or not pk_table_name:
        logger.debug(
            "skipping dbt_constraints.foreign_key test %s "
            "with missing pk_column_name/pk_table_name",
            test_node.unique_id,
        )
        return None
    parent_field_str = str(pk_column_name)

    # dbt_constraints compiles the FK test with refs=[parent_model, child_model]
    # — same shape as a built-in relationships test, so reuse the resolution.
    refs = list(test_node.refs)
    if len(refs) < 2:
        logger.debug(
            "skipping dbt_constraints.foreign_key test %s with refs=%s (expected parent+child)",
            test_node.unique_id,
            refs,
        )
        return None

    parent_ref, child_ref = refs[0], refs[1]
    if _ref_package(parent_ref) is not None or _ref_package(child_ref) is not None:
        logger.debug(
            "skipping cross-package dbt_constraints.foreign_key test %s",
            test_node.unique_id,
        )
        return None

    parent_name = _ref_name(parent_ref)
    child_name = _ref_name(child_ref)
    if parent_name is None or child_name is None:
        return None
    parent_uid = parent_lookup.get(parent_name)
    child_uid = parent_lookup.get(child_name)

    if not parent_uid or not child_uid:
        logger.debug(
            "skipping dbt_constraints.foreign_key test %s — "
            "could not resolve parent=%s or child=%s",
            test_node.unique_id,
            parent_name,
            child_name,
        )
        return None

    # Inference: sibling tests on parent column / child column. The test_index
    # already aliases dbt_constraints.primary_key/unique_key → "unique", so a
    # parent column with a PK declaration produces parent_unique=True.
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
        "to_model_name": parent_name,
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


# ---------------------------------------------------------------------------
# Worker helpers for stage_extract_relationships (DOC-213 U4)
# ---------------------------------------------------------------------------


_VALID_META_KINDS = frozenset({"one_to_one", "one_to_many", "many_to_many"})


def _extract_from_meta(
    manifest: Manifest,
    parent_lookup: dict[str, str],
    test_index: dict[tuple[str, str], set[str]],
    columns_by_uid: dict[str, set[str]],
) -> list[dict[str, Any]]:
    """Walk `manifest.nodes[*].columns[*].meta.docglow.relationships`.

    Emits one ErdRelationship-shaped dict per declaration. See origin §5.4 for
    the schema. Mirrors `_extract_from_test`'s output shape so downstream
    consumers don't need to special-case meta vs test entries.

    Returns entries in declaration order (dict insertion order on
    `manifest.nodes` then `node.columns` then list position). U5 will replace
    naive concat with a proper compose-and-dedupe across test + meta.
    """
    entries: list[dict[str, Any]] = []

    for child_uid, node in manifest.nodes.items():
        if node.resource_type != "model":
            continue

        # Open Question 2: warn-and-ignore model-level meta.docglow.relationships.
        model_meta_docglow = node.meta.get("docglow") if isinstance(node.meta, dict) else None
        if isinstance(model_meta_docglow, dict) and "relationships" in model_meta_docglow:
            logger.debug(
                "model-level docglow.relationships ignored on %s (%s) — "
                "declare on a column instead",
                node.unique_id,
                node.original_file_path or "<unknown path>",
            )

        for child_column, column in node.columns.items():
            col_meta = column.meta if isinstance(column.meta, dict) else {}
            docglow_block = col_meta.get("docglow")
            if not isinstance(docglow_block, dict):
                continue
            raw_rels = docglow_block.get("relationships")
            if raw_rels is None:
                continue
            file_path = node.original_file_path or None
            if not isinstance(raw_rels, list):
                logger.warning(
                    "meta.docglow.relationships on %s.%s must be a list, got %s — skipping (%s)",
                    node.unique_id,
                    child_column,
                    type(raw_rels).__name__,
                    file_path or "<unknown path>",
                )
                continue

            # Track entries within this single column's list to implement
            # last-wins for duplicate (to, field) tuples (case 11).
            seen_keys: dict[tuple[str, str], int] = {}

            for raw_entry in raw_rels:
                if not isinstance(raw_entry, dict):
                    logger.warning(
                        "meta.docglow.relationships entry on %s.%s must be a dict, "
                        "got %s — skipping (%s)",
                        node.unique_id,
                        child_column,
                        type(raw_entry).__name__,
                        file_path or "<unknown path>",
                    )
                    continue

                to_value = raw_entry.get("to")
                field_value = raw_entry.get("field")
                if not isinstance(to_value, str) or not to_value:
                    logger.warning(
                        "meta.docglow.relationships on %s.%s missing/invalid `to` — skipping (%s)",
                        node.unique_id,
                        child_column,
                        file_path or "<unknown path>",
                    )
                    continue
                if not isinstance(field_value, str) or not field_value:
                    logger.warning(
                        "meta.docglow.relationships on %s.%s missing/invalid `field` — "
                        "skipping (%s)",
                        node.unique_id,
                        child_column,
                        file_path or "<unknown path>",
                    )
                    continue

                # Optional kind — validate against allowed values.
                kind_raw = raw_entry.get("kind")
                kind_value: str | None = None
                if kind_raw is not None:
                    if isinstance(kind_raw, str) and kind_raw in _VALID_META_KINDS:
                        kind_value = kind_raw
                    else:
                        logger.warning(
                            "meta.docglow.relationships on %s.%s has unknown kind=%r — "
                            "falling back to inferred (%s)",
                            node.unique_id,
                            child_column,
                            kind_raw,
                            file_path or "<unknown path>",
                        )

                # Optional severity — default warn, lowercased.
                severity_raw = raw_entry.get("severity")
                severity_value = (
                    str(severity_raw).lower() if isinstance(severity_raw, str) else "warn"
                )

                # Optional label.
                label_raw = raw_entry.get("label")
                label_value = label_raw if isinstance(label_raw, str) else None

                # Resolve parent.
                parent_uid = parent_lookup.get(to_value, "")
                if not parent_uid:
                    logger.warning(
                        "meta.docglow.relationships on %s.%s points at unknown model %r "
                        "(ghost edge) — emitted with empty to_unique_id (%s)",
                        node.unique_id,
                        child_column,
                        to_value,
                        file_path or "<unknown path>",
                    )

                # Inference: sibling tests on parent / child columns.
                child_col_lower = child_column.lower()
                parent_col_lower = field_value.lower()
                child_not_null = "not_null" in test_index.get((child_uid, child_col_lower), set())
                parent_unique = (
                    "unique" in test_index.get((parent_uid, parent_col_lower), set())
                    if parent_uid
                    else False
                )
                child_endpoint, parent_endpoint = infer_endpoints(child_not_null, parent_unique)
                child_endpoint, parent_endpoint = apply_meta_kind_override(
                    child_endpoint, parent_endpoint, kind_value
                )

                parent_column_exists = (
                    parent_col_lower in columns_by_uid.get(parent_uid, set())
                    if parent_uid
                    else False
                )

                entry = {
                    "id": relationship_id(child_uid, child_column, parent_uid, field_value, "meta"),
                    "from_unique_id": child_uid,
                    "from_column": child_column,
                    "to_unique_id": parent_uid,
                    "to_column": field_value,
                    "to_model_name": to_value,
                    "kind": kind_value or "inferred",
                    "child_endpoint": child_endpoint,
                    "parent_endpoint": parent_endpoint,
                    "inference_source": "meta",
                    "severity": severity_value,
                    "status": "none",
                    "label": label_value,
                    "test_unique_id": None,
                    "meta_file_path": file_path,
                    "is_synthetic": False,
                    "parent_column_exists": parent_column_exists,
                }

                # Case 11: same (to, field) within the same column → last-wins.
                dedupe_key = (to_value, field_value)
                if dedupe_key in seen_keys:
                    prior_idx = seen_keys[dedupe_key]
                    logger.warning(
                        "duplicate meta.docglow.relationships entry on %s.%s for "
                        "to=%r field=%r — last-wins (%s)",
                        node.unique_id,
                        child_column,
                        to_value,
                        field_value,
                        file_path or "<unknown path>",
                    )
                    entries[prior_idx] = entry
                else:
                    seen_keys[dedupe_key] = len(entries)
                    entries.append(entry)

    return entries


# ---------------------------------------------------------------------------
# Worker helpers for stage_extract_relationships (DOC-213 U5)
# ---------------------------------------------------------------------------


def _compose(
    test_entries: list[dict[str, Any]],
    meta_entries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge test + meta ErdRelationship dicts with conflict + dedupe rules.

    Algorithm (origin §5.4 + plan U5 + U4-handoff resolutions):

    - Real-target rows (`to_unique_id != ""`) are bucketed by the 4-tuple
      `(from_unique_id, from_column, to_unique_id, to_column)`. Test entries
      are inserted first; meta entries either upgrade an existing test row to
      `inference_source="both"` (test wins on `severity`/`status`/
      `test_unique_id`; meta contributes `label`/`meta_file_path`; meta's
      `kind` is adopted only when the test entry's `kind == "inferred"`,
      otherwise the test's `kind` is kept; if the adopted `kind` is one of
      `{"one_to_one","one_to_many","many_to_many"}` we re-run
      `apply_meta_kind_override` on the merged endpoints) or land as a new
      `meta` entry under their own key.

    - Ghost edges (`to_unique_id == ""`, meta-only) are tracked separately
      keyed on `(from_unique_id, from_column, to_model_name, to_column)` so
      that two ghosts pointing at distinct missing models — or two ghosts
      from different child columns to the same missing model — both survive.
      Tests cannot produce ghost edges, so this branch never merges.

    - Soft conflict warning (origin §5.4): if a `(from_unique_id, from_column)`
      pair has both a test-only entry and a meta-only entry that disagree on
      the parent (i.e. they did NOT merge into "both"), log a warning naming
      the meta file path. Both rows are still surfaced.

    - Result is sorted ascending by
      `(from_unique_id, from_column, to_unique_id, to_column)` for
      deterministic snapshots.

    `id` is recomputed via `relationship_id(..., "both")` on every merge so
    the merged hash is stable and distinct from either single-source
    contributor (the source string is part of the hash).
    """

    merged: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    ghosts: list[dict[str, Any]] = []
    seen_ghost_keys: set[tuple[str, str, str, str]] = set()

    for entry in test_entries:
        key: tuple[str, str, str, str] = (
            entry["from_unique_id"],
            entry["from_column"],
            entry["to_unique_id"],
            entry["to_column"],
        )
        merged[key] = dict(entry)

    for entry in meta_entries:
        if entry["to_unique_id"] == "":
            # Ghost edge: keyed on child + to_model_name + parent column so
            # distinct missing parents and distinct child columns are kept apart.
            ghost_key: tuple[str, str, str, str] = (
                entry["from_unique_id"],
                entry["from_column"],
                entry["to_model_name"],
                entry["to_column"],
            )
            if ghost_key in seen_ghost_keys:
                # U4 already enforced last-wins within a column; cross-column
                # ghosts to the same target are distinct keys above.
                continue
            seen_ghost_keys.add(ghost_key)
            ghosts.append(dict(entry))
            continue

        key = (
            entry["from_unique_id"],
            entry["from_column"],
            entry["to_unique_id"],
            entry["to_column"],
        )
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(entry)
            continue

        # Upgrade to "both" — test wins on severity/status/test_unique_id;
        # meta contributes label and meta_file_path.
        merged_entry = dict(existing)
        merged_entry["label"] = entry.get("label")
        merged_entry["meta_file_path"] = entry.get("meta_file_path")
        merged_entry["inference_source"] = "both"

        # Kind handoff: if the test entry was "inferred", adopt meta's kind.
        if existing.get("kind") == "inferred":
            merged_entry["kind"] = entry.get("kind", "inferred")

        # If the now-active kind is a meta-shape override, re-apply endpoint
        # rewriting on top of the merged row.
        active_kind = merged_entry.get("kind")
        if active_kind in _VALID_META_KINDS:
            child_ep, parent_ep = apply_meta_kind_override(
                merged_entry["child_endpoint"],
                merged_entry["parent_endpoint"],
                active_kind,
            )
            merged_entry["child_endpoint"] = child_ep
            merged_entry["parent_endpoint"] = parent_ep

        # Re-issue id with source="both" — relationship_id hashes the source.
        merged_entry["id"] = relationship_id(
            merged_entry["from_unique_id"],
            merged_entry["from_column"],
            merged_entry["to_unique_id"],
            merged_entry["to_column"],
            "both",
        )

        merged[key] = merged_entry

    # Soft conflict check (origin §5.4): same (from, from_column) shared by a
    # test-only row and a meta-only row that did not merge. Surface both, warn.
    by_child: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in merged.values():
        bucket_key = (row["from_unique_id"], row["from_column"])
        by_child.setdefault(bucket_key, []).append(row)
    for (child_uid, child_col), rows in by_child.items():
        sources = {r["inference_source"] for r in rows}
        if "test" in sources and "meta" in sources and "both" not in sources:
            meta_paths = sorted(
                {
                    r.get("meta_file_path") or "<unknown path>"
                    for r in rows
                    if r["inference_source"] == "meta"
                }
            )
            logger.warning(
                "test/meta relationship conflict on %s.%s — both surfaced; "
                "test wins per origin §5.4 (meta file(s): %s)",
                child_uid,
                child_col,
                ", ".join(meta_paths),
            )

    result = list(merged.values()) + ghosts
    result.sort(
        key=lambda r: (
            r["from_unique_id"],
            r["from_column"],
            r["to_unique_id"],
            r["to_column"],
        )
    )
    return result


# ---------------------------------------------------------------------------
# Per-model annotation (DOC-214 U2)
# ---------------------------------------------------------------------------


# Sentinel partner uid for ghost edges (`to_unique_id == ""`). Counted toward
# the from-model's total but stripped from `relationships_summary` because no
# resolvable partner exists. See DOC-214 U2 plan §Approach.
_GHOST_PARTNER_SENTINEL = ""

# Top-N cap for `relationships_summary` (origin §6.4 "top 3 partners").
_SUMMARY_TOP_N = 3


def _annotate_models(
    relationships: list[dict[str, Any]],
    models: dict[str, Any],
) -> None:
    """Mutate each model dict in ``models`` to carry per-model ERD partner stats.

    Adds two keys to every model dict:

    - ``relationships_count: int`` — total partner-edges this model
      participates in. Bidirectional: a single relationship row contributes
      to BOTH endpoints' counts. Ghost edges (``to_unique_id == ""``) count
      toward the from-model's total but produce no resolvable partner.
    - ``relationships_summary: list[RelationshipSummary]`` — top-3 partners
      sorted by ``(edge_count desc, partner_unique_id asc)``. Ghost-sentinel
      partners are excluded.

    Models with no relationships still receive ``relationships_count: 0`` and
    ``relationships_summary: []`` — explicit absence, not missing keys, so
    frontend consumers can distinguish "no FKs" from "ERD disabled" (the
    latter omits both keys entirely).

    Mutation in place mirrors the existing pipeline pattern (see ``_compose``
    operating on bucketed dicts). Re-running this helper on the same context
    overwrites prior annotations rather than accumulating.
    """
    partner_counts: dict[str, Counter[str]] = defaultdict(Counter)
    for rel in relationships:
        from_uid = rel["from_unique_id"]
        to_uid = rel["to_unique_id"]
        if from_uid and to_uid:
            partner_counts[from_uid][to_uid] += 1
            partner_counts[to_uid][from_uid] += 1
        elif from_uid:
            # Ghost edge: count toward `from_uid`'s total, no resolvable partner.
            partner_counts[from_uid][_GHOST_PARTNER_SENTINEL] += 1

    for uid in models:
        counts = partner_counts.get(uid)
        if not counts:
            models[uid]["relationships_count"] = 0
            models[uid]["relationships_summary"] = []
            continue

        total = sum(counts.values())
        # Strip ghost-sentinel before sorting; it contributes to total but not
        # to surfaced partners.
        resolvable = [
            (partner_uid, count)
            for partner_uid, count in counts.items()
            if partner_uid != _GHOST_PARTNER_SENTINEL
        ]
        resolvable.sort(key=lambda pc: (-pc[1], pc[0]))
        summary = [
            {"partner_unique_id": partner_uid, "edge_count": count}
            for partner_uid, count in resolvable[:_SUMMARY_TOP_N]
        ]

        models[uid]["relationships_count"] = total
        models[uid]["relationships_summary"] = summary
