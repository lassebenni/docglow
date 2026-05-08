/**
 * Orphan filter helper for the ERD canvas (DOC-99 U3).
 *
 * Origin requirements §5.6 specifies an "Orphan visibility" toggle that hides
 * tables with zero declared relationships by default. This helper applies
 * that filter to the list of model unique_ids BEFORE layout computation so
 * orphan tables don't reserve grid slots when hidden.
 *
 * `relationships_count` is treated as authoritative — it's the same field
 * `computeErdLayout` uses for sort priority, and the wire shape (DOC-214)
 * declares it on every model. Missing / null counts are treated as orphan
 * (legacy / inconsistent data → hide by default; user can opt in to show).
 */
import type { DocglowModel } from '../types'

/**
 * Filter `modelUids` down to non-orphan models when `showOrphans` is false.
 * When `showOrphans` is true, returns `modelUids` unchanged (preserving order).
 *
 * A model is "orphan" when its `relationships_count` is missing, null, 0, or
 * negative.
 */
export function filterOrphans(
  modelUids: readonly string[],
  models: Readonly<Record<string, DocglowModel>>,
  showOrphans: boolean,
): string[] {
  if (showOrphans) {
    return [...modelUids]
  }
  return modelUids.filter((uid) => {
    const count = models[uid]?.relationships_count ?? 0
    return count > 0
  })
}
