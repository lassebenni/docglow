/**
 * Key-column detection for ERD `keys` node state.
 *
 * Implements origin requirements §5.2: a column qualifies as a "key" if ANY of:
 *
 *   1. It is the `from_column` of an outgoing relationship (FK source on this model).
 *   2. It is the `to_column` of an incoming relationship (FK target on this model).
 *   3. It has BOTH a `unique` test AND a `not_null` test among its sibling tests
 *      (PK-style local declaration).
 *
 * Note: requirement (4) "named in `meta.docglow.relationships`" is already merged
 * into the relationships list by the backend (`stage_extract_relationships`), so
 * rules 1+2 cover meta-declared FKs as well — we deliberately do NOT walk
 * `model.meta.docglow.relationships` here.
 */

import type { DocglowModel, ErdRelationship } from '../types'

const PK_TEST_NAMES = {
  unique: 'unique',
  notNull: 'not_null',
} as const

/**
 * Compute the set of column names that qualify as keys for the given model.
 *
 * @param model — the model whose key columns we want
 * @param relationships — the full top-level `relationships` array from the
 *   payload (this function filters to relevant edges by `from_unique_id` /
 *   `to_unique_id` matching `model.unique_id`)
 * @returns set of column names (case-sensitive, matching `column.name`)
 */
export function computeKeyColumns(
  model: DocglowModel,
  relationships: readonly ErdRelationship[],
): Set<string> {
  const keys = new Set<string>()

  // Rule 3: PK-style — both unique + not_null tests on the same column.
  for (const column of model.columns) {
    let hasUnique = false
    let hasNotNull = false
    for (const test of column.tests) {
      if (test.test_name === PK_TEST_NAMES.unique) {
        hasUnique = true
      } else if (test.test_name === PK_TEST_NAMES.notNull) {
        hasNotNull = true
      }
    }
    if (hasUnique && hasNotNull) {
      keys.add(column.name)
    }
  }

  // Rules 1 + 2: appears as endpoint on any relationship touching this model.
  for (const rel of relationships) {
    if (rel.from_unique_id === model.unique_id) {
      keys.add(rel.from_column)
    }
    if (rel.to_unique_id === model.unique_id) {
      keys.add(rel.to_column)
    }
  }

  return keys
}
