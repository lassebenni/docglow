"""Tests for docglow.generator.erd — pure helpers used by stage_extract_relationships.

Covers DOC-213 / U2 from the implementation plan:
- infer_endpoints crow's-foot truth table (origin requirements doc §5.3)
- apply_meta_kind_override for explicit meta.kind values (origin §5.3 special cases)
- relationship_id stability + sensitivity
"""

from __future__ import annotations

import pytest

from docglow.generator.erd import (
    apply_meta_kind_override,
    infer_endpoints,
    relationship_id,
)


class TestInferEndpoints:
    """The §5.3 inference truth table: {child_not_null, parent_unique} → endpoints."""

    @pytest.mark.parametrize(
        ("child_not_null", "parent_unique", "expected"),
        [
            (True, True, ("one_and_only_one", "one_or_many")),
            (True, False, ("one_and_only_one", "zero_or_many")),
            (False, True, ("zero_or_one", "one_or_many")),
            (False, False, ("zero_or_one", "zero_or_many")),
        ],
        ids=[
            "not_null_and_unique__mandatory_one_to_many",
            "not_null_no_unique__many_to_many_candidate",
            "no_not_null_unique__optional_one_to_many",
            "no_not_null_no_unique__fallback",
        ],
    )
    def test_truth_table(
        self,
        child_not_null: bool,
        parent_unique: bool,
        expected: tuple[str, str],
    ) -> None:
        assert infer_endpoints(child_not_null, parent_unique) == expected


class TestApplyMetaKindOverride:
    """meta.kind hard-overrides the inferred endpoints (origin §5.3 special cases)."""

    def test_one_to_one_overrides_to_unique_unique(self) -> None:
        # Inputs intentionally different from output to prove the override is total.
        assert apply_meta_kind_override("zero_or_one", "zero_or_many", "one_to_one") == (
            "one_and_only_one",
            "one_and_only_one",
        )

    def test_one_to_many_overrides_to_mandatory_one_to_many(self) -> None:
        assert apply_meta_kind_override("zero_or_one", "zero_or_many", "one_to_many") == (
            "one_and_only_one",
            "one_or_many",
        )

    def test_many_to_many_overrides_to_one_or_many_both_sides(self) -> None:
        assert apply_meta_kind_override("zero_or_one", "zero_or_many", "many_to_many") == (
            "one_or_many",
            "one_or_many",
        )

    def test_none_passes_inputs_through_unchanged(self) -> None:
        assert apply_meta_kind_override("zero_or_one", "zero_or_many", None) == (
            "zero_or_one",
            "zero_or_many",
        )

    def test_unknown_kind_passes_inputs_through_unchanged(self) -> None:
        # Forward-compat: an unrecognized kind value (typo, future variant) must not
        # silently corrupt the endpoints. Origin §5.4 logs warnings elsewhere; here
        # we just confirm the helper degrades safely.
        assert apply_meta_kind_override("zero_or_one", "zero_or_many", "bogus") == (
            "zero_or_one",
            "zero_or_many",
        )


class TestRelationshipId:
    """sha1[:12] of the joined inputs — stable across runs, sensitive to every field."""

    def test_stable_for_identical_inputs(self) -> None:
        a = relationship_id(
            "model.proj.orders", "customer_id", "model.proj.customers", "customer_id", "test"
        )
        b = relationship_id(
            "model.proj.orders", "customer_id", "model.proj.customers", "customer_id", "test"
        )
        assert a == b

    def test_returns_12_hex_chars(self) -> None:
        rid = relationship_id("a", "b", "c", "d", "test")
        assert len(rid) == 12
        assert all(c in "0123456789abcdef" for c in rid)

    @pytest.mark.parametrize(
        "field",
        ["from_uid", "from_col", "to_uid", "to_col", "source"],
    )
    def test_changing_any_field_changes_id(self, field: str) -> None:
        base_args = {
            "from_uid": "model.proj.orders",
            "from_col": "customer_id",
            "to_uid": "model.proj.customers",
            "to_col": "customer_id",
            "source": "test",
        }
        base = relationship_id(**base_args)
        mutated_args = dict(base_args)
        mutated_args[field] = base_args[field] + "_x"
        mutated = relationship_id(**mutated_args)
        assert base != mutated, f"id did not change when {field} changed"

    def test_test_vs_meta_source_yield_distinct_ids(self) -> None:
        # Origin §5.4: meta-only and test-only edges with the same column tuple
        # are distinct entries until composition merges them.
        test_id = relationship_id("u1", "c1", "u2", "c2", "test")
        meta_id = relationship_id("u1", "c1", "u2", "c2", "meta")
        assert test_id != meta_id
