"""Pure helpers for stage_extract_relationships (DOC-213).

Crow's-foot inference + meta.kind override + stable relationship id.
No I/O. Functions in this module are referentially transparent.
"""

from __future__ import annotations

import hashlib

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
