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
  type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ErdEdge } from './ErdEdge'
import { ErdEmptyCanvas } from './ErdEmptyCanvas'
import { ErdInspector } from './ErdInspector'
import { ErdNode } from './ErdNode'
import { useErdStore, type ErdNodeState } from '../../stores/erdStore'
import { useProjectStore } from '../../stores/projectStore'
import { computeErdLayout, type ErdNodePosition } from '../../utils/erdLayout'
import { pickHandlePair, SELF_LOOP_HANDLES } from '../../utils/erdEdgeMapping'
import { filterOrphans } from '../../utils/erdOrphanFilter'
import { getProjectKey } from '../../utils/erdProjectKey'

import type { DocglowModel, ErdRelationship } from '../../types'

export type ErdCanvasMode = 'standalone' | 'subgraph'

export interface ErdCanvasProps {
  readonly models: Readonly<Record<string, DocglowModel>>
  readonly relationships: readonly ErdRelationship[]
  /**
   * Render mode. `'standalone'` (default) is the full `/erd` experience:
   * orphan toggle, reset-layout button, persisted drag overrides, and the
   * editorial right-rail inspector.
   *
   * `'subgraph'` is the read-only mini-canvas embedded in `ModelPage`'s ERD
   * tab: drag still works during the session but DOES NOT persist; the
   * orphan toggle, reset button, and inspector are hidden. The segmented
   * control + count remain.
   */
  readonly mode?: ErdCanvasMode
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

/** Stable empty-object reference for the project-overrides selector — avoids
 *  re-render loops from a fresh `{}` literal on every store read. */
const EMPTY_OVERRIDES: Readonly<Record<string, ErdNodePosition>> = Object.freeze({})

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

function ErdCanvasInner({ models, relationships, mode = 'standalone' }: ErdCanvasProps) {
  const isSubgraph = mode === 'subgraph'

  const defaultState = useErdStore((s) => s.defaultState)
  const setDefaultState = useErdStore((s) => s.setDefaultState)
  const setNodePosition = useErdStore((s) => s.setNodePosition)
  const resetLayout = useErdStore((s) => s.resetLayout)
  const showOrphansFromStore = useErdStore((s) => s.showOrphans)
  const setShowOrphans = useErdStore((s) => s.setShowOrphans)

  // Subgraph mode forces orphans-on (orphan filter is meaningless in a 1-hop
  // view of a focal model — every node IS connected by definition).
  const showOrphans = isSubgraph ? true : showOrphansFromStore

  // Project-scoped layout overrides. We resolve the project key from the
  // active payload — `_default_` if no payload (e.g. early-mount or tests).
  const projectData = useProjectStore((s) => s.data)
  const projectKey = useMemo(() => getProjectKey(projectData), [projectData])
  // Standalone mode: subscribe to persisted overrides for THIS project.
  // Subgraph mode: ignore persisted overrides — drag works during the session
  // via `subgraphPositionOverrides` (local state) and reverts on tab switch.
  const persistedOverrides = useErdStore(
    (s) => s.layoutOverrides[projectKey] ?? EMPTY_OVERRIDES,
  )
  const [subgraphPositionOverrides, setSubgraphPositionOverrides] = useState<
    Record<string, ErdNodePosition>
  >({})
  const projectOverrides = isSubgraph
    ? subgraphPositionOverrides
    : persistedOverrides

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const selectEdge = useCallback((id: string) => {
    setSelectedNodeId(null)
    setSelectedEdgeId(id)
  }, [])

  // Pre-filter orphans BEFORE layout so hidden orphans don't reserve grid
  // slots (origin §5.6). `relationships_count` is treated as authoritative —
  // missing/null is interpreted as orphan. See `utils/erdOrphanFilter.ts`.
  const totalModelCount = useMemo(() => Object.keys(models).length, [models])
  const modelUids = useMemo(
    () => filterOrphans(Object.keys(models), models, showOrphans),
    [models, showOrphans],
  )

  const positions = useMemo<Record<string, ErdNodePosition>>(() => {
    const counts: Record<string, number> = {}
    for (const uid of modelUids) {
      counts[uid] = models[uid].relationships_count ?? 0
    }
    return computeErdLayout(modelUids, counts)
  }, [modelUids, models])

  // Build React Flow node array. Each node carries the model + relationships
  // payload its renderer needs. Position lives on the wrapping container.
  // U2: a persisted drag-override (if any) takes precedence over the
  // computed default position.
  const rfNodes = useMemo<Node[]>(() => {
    return modelUids
      .map((uid) => {
        const computed = positions[uid]
        if (!computed) return null
        const override = projectOverrides[uid]
        const pos = override ?? computed
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
  }, [modelUids, models, relationships, positions, projectOverrides, selectedNodeId])

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
        // Pick handle pair based on EFFECTIVE position (override > computed)
        // so dragged nodes pick the correct left/right handle on rerender.
        const fromPos =
          projectOverrides[rel.from_unique_id] ?? positions[rel.from_unique_id]
        const toPos =
          projectOverrides[rel.to_unique_id] ?? positions[rel.to_unique_id]
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
  }, [relationships, models, positions, projectOverrides, selectedEdgeId])

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

  // U2: persist drag-rearranged positions on drag-end. Single update per
  // drag (not per-tick) — keeps localStorage writes cheap.
  // U5: in `subgraph` mode we keep drag interactive during the session but
  // route the override into local state instead of the persisted store, so
  // the embedded mini-canvas doesn't pollute the global `/erd` layout.
  const handleNodeDragStop: OnNodeDrag = useCallback(
    (_event, node) => {
      const next: ErdNodePosition = {
        x: node.position.x,
        y: node.position.y,
      }
      if (isSubgraph) {
        setSubgraphPositionOverrides((prev) => ({ ...prev, [node.id]: next }))
      } else {
        setNodePosition(projectKey, node.id, next)
      }
    },
    [isSubgraph, projectKey, setNodePosition],
  )

  const handleResetLayout = useCallback(() => {
    resetLayout(projectKey)
  }, [projectKey, resetLayout])

  const hasOverrides = Object.keys(projectOverrides).length > 0

  const hasRelationships = relationships.length > 0

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <SegmentedControl value={defaultState} onChange={setDefaultState} />
        {!isSubgraph && (
          <button
            type="button"
            onClick={() => setShowOrphans(!showOrphans)}
            aria-pressed={showOrphans}
            title={
              showOrphans
                ? 'Hide tables with no declared relationships'
                : 'Show tables with no declared relationships'
            }
            className={`px-3 py-1 text-xs rounded border cursor-pointer transition-colors ${
              showOrphans
                ? 'bg-primary text-white border-primary'
                : 'bg-[var(--bg)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]'
            }`}
          >
            Show isolated tables
          </button>
        )}
        {!isSubgraph && hasOverrides && (
          <button
            type="button"
            onClick={handleResetLayout}
            title="Reset all node positions to default"
            className="px-2 py-1 text-xs rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
          >
            Reset layout
          </button>
        )}
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {modelUids.length === totalModelCount
            ? `${modelUids.length} tables`
            : `${modelUids.length}/${totalModelCount} tables`}{' '}
          &middot; {relationships.length} relationships
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
              onNodeDragStop={handleNodeDragStop}
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

        {/* Right rail — editorial inspector. Hidden in `subgraph` mode (the
            mini-canvas is purely a visualization on the model-detail page). */}
        {!isSubgraph && (
          <ErdInspector
            models={models}
            relationships={relationships}
            selectedEdgeId={selectedEdgeId}
            selectedNodeId={selectedNodeId}
            onSelectEdge={selectEdge}
          />
        )}
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
