/**
 * Resolve canvas-pixel anchor points for one ERD edge.
 *
 * Pure helper used by `ErdCanvas` to translate a logical relationship
 * (`from_unique_id` / `to_unique_id` / `from_column` / `to_column`) into the
 * concrete `(x, y)` endpoints + which side of each table the edge attaches
 * to. Lives next to `erdLayout.ts` and `erdNodeDimensions.ts` because it
 * composes their geometry.
 *
 * Returns `null` when either endpoint is missing from `models` or
 * `positions` — i.e., ghost edges with empty `to_unique_id` or
 * relationships that reference parents outside the rendered project. Callers
 * should filter nulls out and skip rendering those edges.
 *
 * Side selection:
 *   - non-self: compare table x-centers; the table with the smaller center
 *     anchors on its right, the other on its left.
 *   - self-referential (same uid both ends): both anchors on the right side
 *     so the curved loop in `ErdEdge` reads correctly.
 *
 * Anchor y selection (per side):
 *   - effective state `compact`           → header center (`nodeY + 18`).
 *   - effective state `keys` / `full`     → resolve the column's index in
 *     the *rendered* row list (filtered to key columns for `keys`, all
 *     columns for `full`) and pass to `computeColumnAnchorY`. If the column
 *     name isn't found in the rendered list, fall back to the header center.
 */

import { computeKeyColumns } from './erdKeys'
import { TABLE_W, ROW_H_HEAD, type ErdNodePosition } from './erdLayout'
import { computeColumnAnchorY } from './erdNodeDimensions'

import type { ErdNodeState } from '../stores/erdStore'
import type { DocglowModel, ErdRelationship } from '../types'

export interface ErdAnchor {
  readonly x: number
  readonly y: number
}

export interface ErdAnchorPair {
  readonly fromAnchor: ErdAnchor
  readonly toAnchor: ErdAnchor
  readonly fromSide: 'left' | 'right'
  readonly toSide: 'left' | 'right'
}

/** Header-center y offset for a node positioned at `nodeY`. */
const HEADER_CENTER_OFFSET = ROW_H_HEAD / 2

/**
 * Build the rendered column list for a model at a given effective state,
 * mirroring `ErdNode`'s own filter logic so anchors line up with rows.
 */
function getRenderedColumns(
  model: DocglowModel,
  state: ErdNodeState,
  relationships: readonly ErdRelationship[],
): readonly { readonly name: string }[] {
  if (state === 'compact') return []
  if (state === 'keys') {
    const keyNames = computeKeyColumns(model, relationships)
    return model.columns.filter((c) => keyNames.has(c.name))
  }
  return model.columns
}

/**
 * Compute the y-coordinate for an endpoint anchored at a specific column
 * within a rendered table card.
 */
function resolveColumnAnchorY(
  nodeY: number,
  state: ErdNodeState,
  rendered: readonly { readonly name: string }[],
  columnName: string,
): number {
  if (state === 'compact') {
    return nodeY + HEADER_CENTER_OFFSET
  }
  const index = rendered.findIndex((c) => c.name === columnName)
  if (index < 0) {
    // Column isn't visible (e.g. not a key when state === 'keys') — fall
    // back to the header center so the edge still has a sensible anchor.
    return nodeY + HEADER_CENTER_OFFSET
  }
  return computeColumnAnchorY(nodeY, state, index, rendered.length)
}

/**
 * Resolve both endpoints (with sides) for one relationship.
 *
 * @returns the anchor pair, or `null` if either uid is unrenderable
 *   (missing from `models` or `positions`).
 */
export function resolveErdAnchors(
  relationship: ErdRelationship,
  models: Readonly<Record<string, DocglowModel>>,
  positions: Readonly<Record<string, ErdNodePosition>>,
  effectiveStates: Readonly<Record<string, ErdNodeState>>,
  relationships: readonly ErdRelationship[],
): ErdAnchorPair | null {
  const fromModel = models[relationship.from_unique_id]
  const toModel = models[relationship.to_unique_id]
  const fromPos = positions[relationship.from_unique_id]
  const toPos = positions[relationship.to_unique_id]
  if (!fromModel || !toModel || !fromPos || !toPos) {
    return null
  }

  const isSelfRef = relationship.from_unique_id === relationship.to_unique_id

  // Side selection.
  const fromCenter = fromPos.x + TABLE_W / 2
  const toCenter = toPos.x + TABLE_W / 2
  let fromSide: 'left' | 'right'
  let toSide: 'left' | 'right'
  if (isSelfRef) {
    fromSide = 'right'
    toSide = 'right'
  } else if (fromCenter < toCenter) {
    fromSide = 'right'
    toSide = 'left'
  } else {
    fromSide = 'left'
    toSide = 'right'
  }

  const fromState = effectiveStates[relationship.from_unique_id] ?? 'compact'
  const toState = effectiveStates[relationship.to_unique_id] ?? 'compact'

  const fromRendered = getRenderedColumns(fromModel, fromState, relationships)
  const toRendered = getRenderedColumns(toModel, toState, relationships)

  const fromY = resolveColumnAnchorY(
    fromPos.y,
    fromState,
    fromRendered,
    relationship.from_column,
  )
  const toY = resolveColumnAnchorY(
    toPos.y,
    toState,
    toRendered,
    relationship.to_column,
  )

  const fromX = fromPos.x + (fromSide === 'right' ? TABLE_W : 0)
  const toX = toPos.x + (toSide === 'right' ? TABLE_W : 0)

  return {
    fromAnchor: { x: fromX, y: fromY },
    toAnchor: { x: toX, y: toY },
    fromSide,
    toSide,
  }
}
