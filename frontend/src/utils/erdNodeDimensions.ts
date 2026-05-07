/**
 * ERD node dimension helpers — colocated companion to `erdLayout.ts`.
 *
 * `computeErdLayout` returns positions only (where each node card sits on the
 * canvas); the *height* of each card depends on its current node-state and
 * the number of rows it actually renders. This module owns that math and the
 * per-row anchor lookup that the SVG edge layer needs.
 *
 * Constants:
 *   - `ROW_H_HEAD` (re-exported from `erdLayout`) — height of the header row.
 *   - `ROW_H_COL` — height of a column row in `keys` and `full` modes
 *     (mirrors the `ROW_H` constant in `examples/erd-design-examples/erd-shared.jsx`).
 *
 * All functions are pure — same input always produces the same output.
 */

import { ROW_H_HEAD } from './erdLayout'

import type { ErdNodeState } from '../stores/erdStore'

/**
 * Height of a single column row inside a node card (in `keys` / `full` modes).
 *
 * Mirrors the mockup's `ROW_H = 22`. Used both for sizing the card body and
 * for computing per-column edge anchor y-coordinates.
 */
export const ROW_H_COL = 22

/**
 * Compute the total rendered height of a node card.
 *
 * @param state — effective rendering state (after the §5.2 zero-keys downgrade).
 * @param keyCount — number of *key* columns this model has (used when state is `keys`).
 * @param totalCount — total number of columns this model has (used when state is `full`).
 * @returns header-only height for `compact`; otherwise header + N rows of body.
 */
export function computeNodeHeight(
  state: ErdNodeState,
  keyCount: number,
  totalCount: number,
): number {
  if (state === 'compact') {
    return ROW_H_HEAD
  }
  const rows = state === 'keys' ? keyCount : totalCount
  return ROW_H_HEAD + rows * ROW_H_COL
}

/**
 * Compute the y-coordinate of the *center* of a given column row.
 *
 * For `compact` (or any column not currently rendered), falls back to the
 * vertical center of the header — the only anchor the card actually exposes.
 *
 * `columnIndex` is the index *among rendered rows*, not the index in the
 * source `model.columns` array. The caller is responsible for figuring out
 * which rows are rendered (e.g., when state is `keys`, the caller should
 * pass the index of the column within the filtered key-column list).
 *
 * @param nodeY — y-coordinate of the node card's top edge (canvas px).
 * @param state — effective rendering state.
 * @param columnIndex — index of the column among rendered rows (0-based).
 * @param totalRowsRendered — number of body rows currently rendered. Used to
 *   detect out-of-range indices and gracefully fall back to the header anchor.
 * @returns y-coordinate of the row's center in canvas px.
 */
export function computeColumnAnchorY(
  nodeY: number,
  state: ErdNodeState,
  columnIndex: number,
  totalRowsRendered: number,
): number {
  if (state === 'compact' || columnIndex < 0 || columnIndex >= totalRowsRendered) {
    return nodeY + ROW_H_HEAD / 2
  }
  return nodeY + ROW_H_HEAD + columnIndex * ROW_H_COL + ROW_H_COL / 2
}
