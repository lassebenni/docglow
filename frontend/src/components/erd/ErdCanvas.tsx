/**
 * ErdCanvas — composes ERD nodes + edges with a top-bar segmented control
 * and a placeholder right rail (DOC-216 will fill in the real inspector).
 *
 * Behavior (origin requirements §3, §5.1, §5.2, §5.9):
 *   - Top-bar segmented control sets the global default node state
 *     (`compact` / `keys` / `full`). Per-node overrides are managed by
 *     `useErdStore.cycleNode` (handled inside `ErdNode`).
 *   - The §5.2 zero-keys-→-compact downgrade is applied here, in one memo,
 *     so all anchor math sees the same effective state the cards will render.
 *   - Layout is the deterministic grid from `computeErdLayout`. No
 *     pan/zoom in v1 (auto-layout / zoom are v1.1 — see §4 non-goals);
 *     native scroll on the canvas area is sufficient for jaffle-shop scale.
 *   - Empty state (no relationships): centered hint with a tiny YAML
 *     snippet. The full two-example empty state ships with DOC-216.
 *
 * Edge layer:
 *   - Single absolute-positioned `<svg>` overlay, `pointer-events: none`,
 *     covering the whole canvas inner area. Each `<ErdEdge>` enables its
 *     own pointer events so edge clicks select without blocking node clicks.
 */

import { useCallback, useMemo, useState } from 'react'
import { ErdEdge } from './ErdEdge'
import { ErdEmptyCanvas } from './ErdEmptyCanvas'
import { ErdInspector } from './ErdInspector'
import { ErdNode } from './ErdNode'
import { useErdStore, type ErdNodeState } from '../../stores/erdStore'
import { computeKeyColumns } from '../../utils/erdKeys'
import {
  computeErdLayout,
  GAP_X,
  ORIGIN_OFFSET,
  ROW_SLOT_H,
  TABLE_W,
  type ErdNodePosition,
} from '../../utils/erdLayout'
import { resolveErdAnchors } from '../../utils/erdAnchors'

import type { DocglowModel, ErdRelationship } from '../../types'

export interface ErdCanvasProps {
  readonly models: Readonly<Record<string, DocglowModel>>
  readonly relationships: readonly ErdRelationship[]
}

const NODE_STATES: readonly ErdNodeState[] = ['compact', 'keys', 'full']
const STATE_LABEL: Record<ErdNodeState, string> = {
  compact: 'Compact',
  keys: 'Keys',
  full: 'Full',
}

/** Trailing canvas padding (right + bottom) so cards don't hug the edge. */
const CANVAS_PADDING = 80

interface SegmentedControlProps {
  readonly value: ErdNodeState
  readonly onChange: (next: ErdNodeState) => void
}

function SegmentedControl({ value, onChange }: SegmentedControlProps) {
  return (
    <div
      className="flex items-center rounded overflow-hidden border border-[var(--border)]"
      role="group"
      aria-label="Node state"
    >
      {NODE_STATES.map((state) => {
        const active = state === value
        return (
          <button
            key={state}
            type="button"
            onClick={() => onChange(state)}
            aria-pressed={active}
            className={`px-3 py-1 text-xs cursor-pointer transition-colors
              ${active
                ? 'bg-primary text-white'
                : 'bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]'
              }`}
          >
            {STATE_LABEL[state]}
          </button>
        )
      })}
    </div>
  )
}

export function ErdCanvas({ models, relationships }: ErdCanvasProps) {
  const defaultState = useErdStore((s) => s.defaultState)
  const expandedOverrides = useErdStore((s) => s.expandedOverrides)
  const setDefaultState = useErdStore((s) => s.setDefaultState)

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Mutual-exclusion wrappers — selecting one clears the other so the
  // inspector branches don't fight (§5.7). The edge-priority safety net
  // in `ErdInspector` covers the (theoretically unreachable) double-set.
  const selectEdge = useCallback((id: string) => {
    setSelectedNodeId(null)
    setSelectedEdgeId(id)
  }, [])
  const selectNode = useCallback((uid: string) => {
    setSelectedEdgeId(null)
    setSelectedNodeId(uid)
  }, [])

  const modelUids = useMemo(() => Object.keys(models), [models])

  // Effective state for every model uid. Applies override → default →
  // §5.2 zero-keys-downgrade, in that order. Computed once so anchor math
  // and node rendering stay in lockstep.
  const effectiveStates = useMemo<Record<string, ErdNodeState>>(() => {
    const result: Record<string, ErdNodeState> = {}
    for (const uid of modelUids) {
      const model = models[uid]
      const override = expandedOverrides[uid]
      const base: ErdNodeState = override ? 'full' : defaultState
      if (base === 'compact') {
        result[uid] = 'compact'
      } else {
        const keys = computeKeyColumns(model, relationships)
        result[uid] = keys.size === 0 ? 'compact' : base
      }
    }
    return result
  }, [modelUids, models, expandedOverrides, defaultState, relationships])

  const positions = useMemo<Record<string, ErdNodePosition>>(() => {
    const counts: Record<string, number> = {}
    for (const uid of modelUids) {
      counts[uid] = models[uid].relationships_count ?? 0
    }
    return computeErdLayout(modelUids, counts)
  }, [modelUids, models])

  const anchors = useMemo(() => {
    return relationships
      .map((rel) => {
        const pair = resolveErdAnchors(
          rel,
          models,
          positions,
          effectiveStates,
          relationships,
        )
        return pair ? { rel, pair } : null
      })
      .filter((entry): entry is { rel: ErdRelationship; pair: NonNullable<ReturnType<typeof resolveErdAnchors>> } => entry !== null)
  }, [relationships, models, positions, effectiveStates])

  const { canvasW, canvasH } = useMemo(() => {
    let maxX = 0
    let maxY = 0
    for (const uid of modelUids) {
      const pos = positions[uid]
      if (!pos) continue
      maxX = Math.max(maxX, pos.x + TABLE_W)
      maxY = Math.max(maxY, pos.y + ROW_SLOT_H)
    }
    // Ensure non-zero canvas even when project is empty.
    return {
      canvasW: Math.max(maxX + CANVAS_PADDING, ORIGIN_OFFSET + TABLE_W + GAP_X),
      canvasH: Math.max(maxY + CANVAS_PADDING, ORIGIN_OFFSET + ROW_SLOT_H),
    }
  }, [modelUids, positions])

  const clearSelection = useCallback(() => {
    setSelectedEdgeId(null)
    setSelectedNodeId(null)
  }, [])

  const hasRelationships = relationships.length > 0

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <SegmentedControl value={defaultState} onChange={setDefaultState} />
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {modelUids.length} tables &middot; {relationships.length} relationships
        </span>
      </div>

      {/* Body: canvas + right rail */}
      <div className="flex-1 flex min-h-0">
        {/* Canvas area */}
        <div
          className="flex-1 relative overflow-auto"
          style={{
            background:
              'radial-gradient(circle, var(--border, #e2e8f0) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
          onClick={clearSelection}
        >
          {!hasRelationships ? (
            <ErdEmptyCanvas />
          ) : (
            <div
              className="relative"
              style={{ width: canvasW, height: canvasH }}
            >
              {/* Edge layer (under nodes; nodes paint on top). */}
              <svg
                className="absolute inset-0"
                width={canvasW}
                height={canvasH}
                style={{ pointerEvents: 'none', overflow: 'visible' }}
                aria-hidden="true"
              >
                {anchors.map(({ rel, pair }) => (
                  <ErdEdge
                    key={rel.id}
                    relationship={rel}
                    fromAnchor={pair.fromAnchor}
                    toAnchor={pair.toAnchor}
                    fromSide={pair.fromSide}
                    toSide={pair.toSide}
                    selected={selectedEdgeId === rel.id}
                    onSelect={selectEdge}
                  />
                ))}
              </svg>

              {/* Node layer. */}
              {modelUids.map((uid) => {
                const pos = positions[uid]
                if (!pos) return null
                return (
                  <ErdNode
                    key={uid}
                    model={models[uid]}
                    relationships={relationships}
                    position={pos}
                    selected={selectedNodeId === uid}
                    onSelect={selectNode}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* Right rail — editorial inspector. Node selection arrives from
            `ErdNode` click handlers; edge selection from `ErdEdge`. The
            inspector renders edge → node → empty in priority order. */}
        <ErdInspector
          models={models}
          relationships={relationships}
          selectedEdgeId={selectedEdgeId}
          selectedNodeId={selectedNodeId}
          onSelectEdge={selectEdge}
        />
      </div>
    </div>
  )
}
