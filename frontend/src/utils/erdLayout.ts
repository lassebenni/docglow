/**
 * Deterministic grid layout for ERD nodes.
 *
 * v1 ships a hand-derived grid layout (per origin requirements §4 non-goals:
 * "no auto-layout — ELK / d3-force is v1.1"). This module computes
 * deterministic `(x, y)` positions for a flat list of model unique_ids.
 *
 * Sort order: by `relationships_count` descending (most-connected first), with
 * alphabetical unique_id as the tiebreak. Packs into a `ceil(sqrt(N))`-column
 * grid so the canvas stays roughly square regardless of project size.
 *
 * Determinism guarantee: identical input always produces identical output.
 * Same constants are exported so downstream renderers (U2/U3) can compute
 * edge anchors without redefining cell geometry.
 */

/** Width of a rendered table card in px. */
export const TABLE_W = 220;
/** Height of the table header row in px (used for edge anchor math). */
export const ROW_H_HEAD = 36;
/** Horizontal gap between adjacent grid cells in px. */
export const GAP_X = 80;
/** Vertical gap between adjacent grid cells in px. */
export const GAP_Y = 60;
/** Reserved vertical slot per cell (header + body estimate) in px. */
export const ROW_SLOT_H = 200;
/** Outer margin offset (top/left) of the grid in px. */
export const ORIGIN_OFFSET = 40;

export interface ErdNodePosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Compute deterministic grid positions for a set of model unique_ids.
 *
 * @param modelUids — list of model unique_ids to lay out (any order)
 * @param relationshipsCounts — map from unique_id → relationships_count;
 *   missing entries are treated as 0
 * @returns map from unique_id → `{ x, y }` position in canvas px
 */
export function computeErdLayout(
  modelUids: readonly string[],
  relationshipsCounts: Readonly<Record<string, number>>,
): Record<string, ErdNodePosition> {
  if (modelUids.length === 0) {
    return {};
  }

  // Sort by relationships_count desc, then unique_id asc for stable tiebreak.
  // Copy first — never mutate the caller's array.
  const sorted = [...modelUids].sort((a, b) => {
    const countA = relationshipsCounts[a] ?? 0;
    const countB = relationshipsCounts[b] ?? 0;
    if (countA !== countB) {
      return countB - countA;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const cols = Math.ceil(Math.sqrt(sorted.length));
  const cellWidth = TABLE_W + GAP_X;
  const cellHeight = ROW_SLOT_H + GAP_Y;

  const positions: Record<string, ErdNodePosition> = {};
  for (let i = 0; i < sorted.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions[sorted[i]] = {
      x: col * cellWidth + ORIGIN_OFFSET,
      y: row * cellHeight + ORIGIN_OFFSET,
    };
  }

  return positions;
}
