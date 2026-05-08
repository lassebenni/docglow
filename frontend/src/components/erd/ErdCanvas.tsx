/**
 * ErdCanvas — composes ERD nodes + edges with a top-bar segmented control
 * and the editorial right-rail inspector.
 *
 * v1.1 (DOC-218 U1): the canvas internals are now a `@xyflow/react`
 * `<ReactFlow>` viewport with custom node / edge types. Drag, pan, and zoom
 * come native. Crow's-foot edges remain custom-rendered via `ErdEdge`.
 *
 * Behavior preserved from v1 (DOC-213→DOC-216):
 *   - Top-bar segmented control sets the global default node state
 *     (`compact` / `keys` / `full`). Per-node overrides cycle on click via
 *     `useErdStore.cycleNode` (still triggered inside `ErdNode`).
 *   - Selection wiring: click an edge → inspector edge branch; click a node
 *     → inspector node branch + state cycle; click the canvas background →
 *     both clear (mutual exclusion preserved).
 *   - Crow's-foot edge rendering — same four glyphs, same status colors,
 *     same self-loop curve.
 *   - Empty-state branch (`ErdEmptyCanvas`) renders before the React Flow
 *     viewport is mounted when there are zero relationships.
 *
 * Known precision regression from v1: edges anchor to the node center (one
 * Handle per side) rather than to the specific column row. The inspector
 * still gives the precise column context. Reverting to per-column handles
 * is deferred until / unless v1.2's auto-layout work needs them.
 */

import { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type EdgeMouseHandler,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ErdEdge } from './ErdEdge'
import { ErdEmptyCanvas } from './ErdEmptyCanvas'
import { ErdInspector } from './ErdInspector'
import { ErdNode } from './ErdNode'
import { useErdStore, type ErdNodeState } from '../../stores/erdStore'
import { computeErdLayout, type ErdNodePosition } from '../../utils/erdLayout'
import { pickHandlePair, SELF_LOOP_HANDLES } from '../../utils/erdEdgeMapping'

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

const nodeTypes: NodeTypes = {
  erdTable: ErdNode,
}

const edgeTypes: EdgeTypes = {
  erdRelationship: ErdEdge,
}

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

function ErdCanvasInner({ models, relationships }: ErdCanvasProps) {
  const defaultState = useErdStore((s) => s.defaultState)
  const setDefaultState = useErdStore((s) => s.setDefaultState)

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const selectEdge = useCallback((id: string) => {
    setSelectedNodeId(null)
    setSelectedEdgeId(id)
  }, [])

  const modelUids = useMemo(() => Object.keys(models), [models])

  const positions = useMemo<Record<string, ErdNodePosition>>(() => {
    const counts: Record<string, number> = {}
    for (const uid of modelUids) {
      counts[uid] = models[uid].relationships_count ?? 0
    }
    return computeErdLayout(modelUids, counts)
  }, [modelUids, models])

  // Build React Flow node array. Each node carries the model + relationships
  // payload its renderer needs. Position lives on the wrapping container.
  const rfNodes = useMemo<Node[]>(() => {
    return modelUids
      .map((uid) => {
        const pos = positions[uid]
        if (!pos) return null
        const node: Node = {
          id: uid,
          type: 'erdTable',
          position: { x: pos.x, y: pos.y },
          data: {
            model: models[uid],
            relationships,
            selected: selectedNodeId === uid,
          },
          // Drag is on by default (R1 — landed in U2 via persistence).
          // Connection UI doesn't apply to the ERD — disable it.
          connectable: false,
          // Built-in selection styling fights our manual selection — turn off.
          selectable: false,
        }
        return node
      })
      .filter((n): n is Node => n !== null)
  }, [modelUids, models, relationships, positions, selectedNodeId])

  // Build React Flow edge array. Skip ghost edges (parent missing) — same as
  // v1's behavior in `resolveErdAnchors` (returned null, canvas filtered).
  // Skip relationships whose endpoints aren't in the rendered set —
  // defensive; shouldn't happen in practice but stay resilient.
  const rfEdges = useMemo<Edge[]>(() => {
    return relationships
      .filter((rel) => {
        if (rel.parent_column_exists === false) return false
        if (rel.to_unique_id === '') return false
        if (!models[rel.from_unique_id]) return false
        if (!models[rel.to_unique_id]) return false
        if (!positions[rel.from_unique_id]) return false
        if (!positions[rel.to_unique_id]) return false
        return true
      })
      .map((rel) => {
        const isSelfLoop = rel.from_unique_id === rel.to_unique_id
        const fromPos = positions[rel.from_unique_id]
        const toPos = positions[rel.to_unique_id]
        const handles = isSelfLoop
          ? SELF_LOOP_HANDLES
          : pickHandlePair(fromPos.x, toPos.x)

        const edge: Edge = {
          id: rel.id,
          source: rel.from_unique_id,
          target: rel.to_unique_id,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: 'erdRelationship',
          data: {
            rel,
            selected: selectedEdgeId === rel.id,
          },
          selectable: false,
        }
        return edge
      })
  }, [relationships, models, positions, selectedEdgeId])

  const handleEdgeClick: EdgeMouseHandler = useCallback((event, edge) => {
    event.stopPropagation()
    setSelectedEdgeId(edge.id)
    setSelectedNodeId(null)
  }, [])

  const handleNodeClick: NodeMouseHandler = useCallback((event, node) => {
    event.stopPropagation()
    setSelectedEdgeId(null)
    setSelectedNodeId(node.id)
    // ErdNode's own click handler still fires `cycleNode` for the per-node
    // state cycle, so the bundled selection-and-cycle UX from DOC-216 is
    // preserved without duplicating the cycle here.
  }, [])

  const handlePaneClick = useCallback(() => {
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
          className="flex-1 relative min-h-0"
          style={{
            background:
              'radial-gradient(circle, var(--border, #e2e8f0) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
          {!hasRelationships ? (
            <ErdEmptyCanvas />
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
              onPaneClick={handlePaneClick}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              minZoom={0.1}
              maxZoom={2.5}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable={false}
              selectNodesOnDrag={false}
              proOptions={{ hideAttribution: true }}
            >
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={() => '#2563eb'}
                maskColor="rgba(0,0,0,0.15)"
                pannable
                zoomable
              />
            </ReactFlow>
          )}
        </div>

        {/* Right rail — editorial inspector. */}
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

export function ErdCanvas(props: ErdCanvasProps) {
  return (
    <ReactFlowProvider>
      <ErdCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
