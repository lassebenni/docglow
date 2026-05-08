/**
 * Pure helper used by `ErdCanvas` to decide which React Flow handles an edge
 * should attach to, based on the relative x-positions of the source and
 * target nodes.
 *
 * The four handle IDs declared on `ErdNode` are:
 *   - `'source-left'`, `'source-right'`, `'target-left'`, `'target-right'`.
 *
 * Side rules (mirror v1's `erdAnchors.ts` behavior):
 *   - Self-loop (`fromUid === toUid`): both ends on the right side, so the
 *     curved Bezier loop in `ErdEdge` reads correctly.
 *   - Otherwise, compare x-centers. If `from` sits to the LEFT of `to`, the
 *     edge exits `from` on the right and enters `to` on the left. The
 *     opposite case mirrors that.
 */

export interface ErdHandlePair {
  readonly sourceHandle: 'source-left' | 'source-right'
  readonly targetHandle: 'target-left' | 'target-right'
}

/**
 * Pick source/target handle IDs for a non-self-loop edge.
 *
 * @param fromX — x-coordinate (any reference point, e.g. left edge or center)
 *   of the source node.
 * @param toX — x-coordinate of the target node, using the same reference.
 */
export function pickHandlePair(fromX: number, toX: number): ErdHandlePair {
  if (fromX <= toX) {
    return { sourceHandle: 'source-right', targetHandle: 'target-left' }
  }
  return { sourceHandle: 'source-left', targetHandle: 'target-right' }
}

/**
 * Self-loops attach to the same side both ends.
 */
export const SELF_LOOP_HANDLES: ErdHandlePair = {
  sourceHandle: 'source-right',
  targetHandle: 'target-right',
}
