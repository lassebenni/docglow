/**
 * ERD node row-height constant.
 *
 * Pre-React-Flow this module also owned `computeNodeHeight` and
 * `computeColumnAnchorY` for the manual SVG edge layer. Both were retired in
 * the React Flow migration (DOC-218 U1) — React Flow resolves edge anchors
 * via `<Handle>` placement on the node component, and per-column anchor
 * precision is intentionally relaxed to per-side anchors (see U1 commit).
 *
 * `ROW_H_COL` is the only export still in active use — `ErdNode` consumes
 * it for column-row layout in `keys` and `full` modes.
 */

export const ROW_H_COL = 22
