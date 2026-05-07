/**
 * ErdEdge — one SVG edge between two ErdNodes on the canvas.
 *
 * Returns an `<g>` group; the parent `<svg>` lives in the U3 canvas. The
 * caller pre-computes endpoint anchors (because they depend on each rendered
 * node's *current* height, which only the canvas knows after rendering all
 * nodes — see `erdNodeDimensions.ts`).
 *
 * Visual reference: `examples/erd-design-examples/erd-shared.jsx` (`EdgeLayer`,
 * `CrowsFoot`, `buildEdgePath`).
 *
 * Crow's-foot glyph mapping (origin requirements §5.3):
 *   - one_and_only_one  → `||`  (two parallel perpendicular bars)
 *   - zero_or_one       → `o|`  (small open circle then a perpendicular bar)
 *   - one_or_many       → `}|`  (three-prong fork then a perpendicular bar)
 *   - zero_or_many      → `}o`  (three-prong fork then a small open circle)
 *
 * Special cases:
 *   - Self-referential FK (`from_unique_id === to_unique_id`): renders a
 *     curved Bezier loop on the right side of the table instead of an
 *     orthogonal H-V-H path. Edge case 4 in the requirements doc.
 *   - Ghost edge (`parent_column_exists === false` OR `to_unique_id === ''`):
 *     dashed gray, signals the relationship references a missing parent
 *     (edge cases 6 and 8 in the requirements doc).
 */

import { useCallback } from 'react'
import type { ErdEndpoint, ErdRelationship, ErdStatus } from '@docglow/shared-types'

export interface ErdEdgeProps {
  readonly relationship: ErdRelationship
  readonly fromAnchor: { readonly x: number; readonly y: number }
  readonly toAnchor: { readonly x: number; readonly y: number }
  readonly fromSide: 'left' | 'right'
  readonly toSide: 'left' | 'right'
  readonly selected?: boolean
  readonly onSelect?: (id: string) => void
}

/** Status → edge stroke color. Mirrors mockup `STATUS_COLOR`. */
const STATUS_COLOR: Record<ErdStatus, string> = {
  pass: '#16a34a',
  fail: '#dc2626',
  warn: '#d97706',
  not_run: '#64748b',
  none: '#64748b',
}

const SELECTED_COLOR = '#f59e0b'
const GHOST_COLOR = '#94a3b8'

/** How far outside the anchor the crow's-foot glyph sits. */
const GLYPH_OFFSET = 8
/** Half-height of the perpendicular bar / fork. */
const GLYPH_HALF = 5
/** Radius of the open circle in `zero_or_*` glyphs. */
const GLYPH_CIRCLE_R = 3

/**
 * Build an orthogonal H-V-H path from `from` to `to`. Mirrors mockup
 * `buildEdgePath`. Used for non-self-referential edges.
 */
function buildOrthogonalPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const midX = (from.x + to.x) / 2
  return `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`
}

/**
 * Build a Bezier loop for self-referential edges. Loops out to the right of
 * the table, around, and back. Both anchors are typically on the same
 * (right) side of the same table.
 */
function buildSelfLoopPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const c1x = from.x + 60
  const c1y = from.y - 30
  const c2x = from.x + 60
  const c2y = to.y + 30
  return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`
}

interface CrowsFootProps {
  readonly endpoint: ErdEndpoint
  readonly anchor: { readonly x: number; readonly y: number }
  readonly side: 'left' | 'right'
  readonly stroke: string
  readonly opacity?: number
}

/**
 * Render a crow's-foot glyph at one endpoint of an edge.
 *
 * `side` is which side of the *table* the edge attaches to — `'right'` means
 * the edge exits/enters from the right side, so the glyph sits to the right
 * of the anchor (positive x offset). `'left'` is mirrored.
 *
 * The glyph composes from two primitives placed along the horizontal axis:
 *   - "outer" primitive (further from the anchor) — the cardinality marker
 *   - "inner" primitive (closer to the anchor) — the optionality marker
 *
 * Per origin §5.3:
 *   - `one_and_only_one` (`||`): outer bar + inner bar
 *   - `zero_or_one`      (`o|`): outer circle + inner bar
 *   - `one_or_many`      (`}|`): outer fork + inner bar
 *   - `zero_or_many`     (`}o`): outer fork + inner circle
 */
function CrowsFoot({ endpoint, anchor, side, stroke, opacity = 1 }: CrowsFootProps) {
  const dir = side === 'right' ? 1 : -1
  // Inner primitive sits one offset out; outer sits two offsets out.
  const innerX = anchor.x + dir * GLYPH_OFFSET
  const outerX = anchor.x + dir * GLYPH_OFFSET * 2

  // Pick which primitive goes inner / outer based on glyph spec.
  const outerKind: 'bar' | 'circle' | 'fork' =
    endpoint === 'one_and_only_one'
      ? 'bar'
      : endpoint === 'zero_or_one'
        ? 'circle'
        : 'fork' // one_or_many | zero_or_many
  const innerKind: 'bar' | 'circle' =
    endpoint === 'zero_or_many' ? 'circle' : 'bar'

  const renderPrimitive = (kind: 'bar' | 'circle' | 'fork', x: number, key: string) => {
    if (kind === 'bar') {
      return (
        <line
          key={key}
          x1={x}
          y1={anchor.y - GLYPH_HALF}
          x2={x}
          y2={anchor.y + GLYPH_HALF}
          stroke={stroke}
          strokeWidth={1.5}
          opacity={opacity}
          strokeLinecap="round"
        />
      )
    }
    if (kind === 'circle') {
      return (
        <circle
          key={key}
          cx={x}
          cy={anchor.y}
          r={GLYPH_CIRCLE_R}
          fill="var(--bg, #fff)"
          stroke={stroke}
          strokeWidth={1.5}
          opacity={opacity}
        />
      )
    }
    // Fork — three prongs fanning out from the inner side toward the outer side.
    // Base sits at `innerX` (closer to anchor); tips at `x` (the outer position).
    return (
      <g key={key} stroke={stroke} strokeWidth={1.25} opacity={opacity} fill="none">
        <line x1={innerX} y1={anchor.y} x2={x} y2={anchor.y - GLYPH_HALF} />
        <line x1={innerX} y1={anchor.y} x2={x} y2={anchor.y} />
        <line x1={innerX} y1={anchor.y} x2={x} y2={anchor.y + GLYPH_HALF} />
      </g>
    )
  }

  return (
    <g>
      {renderPrimitive(outerKind, outerX, 'outer')}
      {renderPrimitive(innerKind, innerX, 'inner')}
    </g>
  )
}

export function ErdEdge({
  relationship,
  fromAnchor,
  toAnchor,
  fromSide,
  toSide,
  selected,
  onSelect,
}: ErdEdgeProps) {
  const isGhost =
    relationship.parent_column_exists === false || relationship.to_unique_id === ''
  const isSelfRef =
    relationship.from_unique_id === relationship.to_unique_id &&
    relationship.from_unique_id !== ''

  const baseStroke = isGhost
    ? GHOST_COLOR
    : (STATUS_COLOR[relationship.status] ?? STATUS_COLOR.none)
  const stroke = selected ? SELECTED_COLOR : baseStroke
  const strokeWidth = selected ? 2 : 1.25
  const dasharray = isGhost ? '4 4' : undefined

  const path = isSelfRef
    ? buildSelfLoopPath(fromAnchor, toAnchor)
    : buildOrthogonalPath(fromAnchor, toAnchor)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelect?.(relationship.id)
    },
    [onSelect, relationship.id],
  )

  return (
    <g
      id={`erd-edge-${relationship.id}`}
      data-erd-edge-id={relationship.id}
      style={{ pointerEvents: 'auto', cursor: 'pointer' }}
      onClick={handleClick}
    >
      {/* Wide invisible hit-path for click target. */}
      <path d={path} stroke="transparent" strokeWidth={14} fill="none" />
      {/* Visible edge line. */}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dasharray}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Crow's-foot glyphs — child endpoint at fromAnchor, parent at toAnchor.
          Suppressed for ghost edges (no parent to mark) and self-loops (the
          curved geometry doesn't read with horizontal glyphs). */}
      {!isGhost && !isSelfRef && (
        <>
          <CrowsFoot
            endpoint={relationship.child_endpoint}
            anchor={fromAnchor}
            side={fromSide}
            stroke={stroke}
          />
          <CrowsFoot
            endpoint={relationship.parent_endpoint}
            anchor={toAnchor}
            side={toSide}
            stroke={stroke}
          />
        </>
      )}
    </g>
  )
}
