/**
 * Pure helper used by `ErdCanvas` to decide which React Flow handles an edge
 * should attach to, based on the relative x-positions of the source and
 * target nodes — and, when the connected node is showing column rows
 * (`keys` / `full` state), based on the FK column name so the edge anchors
 * at the column row instead of the node midpoint.
 *
 * Generic side handles declared on `ErdNode`:
 *   - `'source-left'`, `'source-right'`, `'target-left'`, `'target-right'`.
 *
 * Per-column handles declared inside each `ColumnRow`:
 *   - `'source-left-${col}'`, `'source-right-${col}'`,
 *     `'target-left-${col}'`, `'target-right-${col}'`.
 *
 * Side rules (mirror v1's `erdAnchors.ts` behavior):
 *   - Self-loop (`fromUid === toUid`): both ends on the right side, so the
 *     curved Bezier loop in `ErdEdge` reads correctly.
 *   - Otherwise, compare x-centers. If `from` sits to the LEFT of `to`, the
 *     edge exits `from` on the right and enters `to` on the left. The
 *     opposite case mirrors that.
 *
 * Anchor-precision rules (DOC-99 follow-up — restore per-column anchoring):
 *   - If a node is in `compact` state, no column rows are rendered, so we
 *     fall back to its generic side handle.
 *   - If a node is in `keys` or `full` state AND the connected column is
 *     currently rendered on that node, we pick the per-column handle ID.
 *   - If the column ISN'T rendered (rare corner case — keys-mode node where
 *     a `meta.docglow.relationships`-declared FK column lacks both
 *     PK-tests AND tests-block FK declaration), fall back to the generic
 *     side handle.
 */

export type ErdNodeRenderState = 'compact' | 'keys' | 'full'

export interface ErdHandlePair {
  readonly sourceHandle: string
  readonly targetHandle: string
}

type GenericSourceHandle = 'source-left' | 'source-right'
type GenericTargetHandle = 'target-left' | 'target-right'

/**
 * Pick generic side handle IDs for a non-self-loop edge based purely on the
 * relative x-positions of the two nodes. Kept exported for backwards-compat
 * (older call sites that only need side selection).
 */
export function pickHandlePair(
  fromX: number,
  toX: number,
): { sourceHandle: GenericSourceHandle; targetHandle: GenericTargetHandle } {
  if (fromX <= toX) {
    return { sourceHandle: 'source-right', targetHandle: 'target-left' }
  }
  return { sourceHandle: 'source-left', targetHandle: 'target-right' }
}

export interface PickEdgeHandlesArgs {
  readonly fromX: number
  readonly toX: number
  readonly fromState: ErdNodeRenderState
  readonly toState: ErdNodeRenderState
  /** Whether `fromColumn` is currently rendered as a row on the from-node. */
  readonly fromHasColumn: boolean
  /** Whether `toColumn` is currently rendered as a row on the to-node. */
  readonly toHasColumn: boolean
  readonly fromColumn: string
  readonly toColumn: string
}

/**
 * Pick source/target handle IDs for a non-self-loop edge with column
 * awareness. Falls back to the generic side handle when the column row
 * isn't rendered (compact state, or column not in the visible set).
 */
export function pickEdgeHandles(args: PickEdgeHandlesArgs): ErdHandlePair {
  const generic = pickHandlePair(args.fromX, args.toX)
  const fromSide: 'left' | 'right' =
    generic.sourceHandle === 'source-right' ? 'right' : 'left'
  const toSide: 'left' | 'right' =
    generic.targetHandle === 'target-right' ? 'right' : 'left'

  const sourceHandle =
    args.fromState !== 'compact' && args.fromHasColumn
      ? `source-${fromSide}-${args.fromColumn}`
      : generic.sourceHandle
  const targetHandle =
    args.toState !== 'compact' && args.toHasColumn
      ? `target-${toSide}-${args.toColumn}`
      : generic.targetHandle

  return { sourceHandle, targetHandle }
}

/**
 * Self-loops attach to the same side both ends — generic version, used when
 * the node is compact OR when the columns aren't rendered.
 */
export const SELF_LOOP_HANDLES: ErdHandlePair = {
  sourceHandle: 'source-right',
  targetHandle: 'target-right',
}

export interface PickSelfLoopHandlesArgs {
  readonly state: ErdNodeRenderState
  readonly fromHasColumn: boolean
  readonly toHasColumn: boolean
  readonly fromColumn: string
  readonly toColumn: string
}

/**
 * Self-loop handle picker. Both ends route through the right side. When
 * the node is showing column rows AND the column is rendered, use the
 * per-column handle on that side; otherwise fall back to the generic one.
 */
export function pickSelfLoopHandles(
  args: PickSelfLoopHandlesArgs,
): ErdHandlePair {
  const sourceHandle =
    args.state !== 'compact' && args.fromHasColumn
      ? `source-right-${args.fromColumn}`
      : SELF_LOOP_HANDLES.sourceHandle
  const targetHandle =
    args.state !== 'compact' && args.toHasColumn
      ? `target-right-${args.toColumn}`
      : SELF_LOOP_HANDLES.targetHandle
  return { sourceHandle, targetHandle }
}
