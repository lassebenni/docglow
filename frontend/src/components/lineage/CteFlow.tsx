import { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  MarkerType,
  Position,
  Handle,
  type Node,
  type Edge,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import type {
  SqlGraph,
  SqlGraphColumnDep,
  SqlGraphColumnLineage,
  SqlGraphNode,
} from '../../types'
import { JOIN_KEY_PALETTE } from '../../utils/joinKeys'
import {
  colKey,
  collectColumnPath,
  type ColumnPathStep,
} from '../../utils/sqlGraphColumns'

const NODE_W = 188
const HEADER_H = 40
const COL_ROW_H = 18
const MAX_VISIBLE_COLS = 14
const JOIN_W = 140
const JOIN_H = 44
const PATH_COLOR = '#d97706'

const KIND_ACCENT: Record<string, string> = {
  parent: '#16a34a',
  cte: '#7c3aed',
  join: '#2563eb',
  output: '#c2410c',
}

function nodeHeight(n: SqlGraphNode): number {
  if (n.kind === 'join') return JOIN_H
  const cols = n.columns?.length ?? 0
  const visible = Math.min(cols, MAX_VISIBLE_COLS)
  return HEADER_H + (visible > 0 ? visible * COL_ROW_H + 4 : 8)
}

function layoutGraph(graph: SqlGraph): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 72, marginx: 24, marginy: 24 })

  for (const n of graph.nodes) {
    const isJoin = n.kind === 'join'
    g.setNode(n.id, {
      width: isJoin ? JOIN_W : NODE_W,
      height: nodeHeight(n),
    })
  }
  for (const e of graph.edges) {
    g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  let colorIdx = 0
  const relColor = new Map<string, string>()
  const colorForJoin = (n: SqlGraphNode): string | undefined => {
    if (n.kind !== 'join' || !n.join_keys?.length) return undefined
    const key = n.join_keys.map(k => `${k.left_column}=${k.right_column}`).sort().join('|')
    let c = relColor.get(key)
    if (!c) {
      c = JOIN_KEY_PALETTE[colorIdx % JOIN_KEY_PALETTE.length]!
      colorIdx += 1
      relColor.set(key, c)
    }
    return c
  }

  const nodes: Node[] = graph.nodes.map(n => {
    const pos = g.node(n.id)
    const w = n.kind === 'join' ? JOIN_W : NODE_W
    const h = nodeHeight(n)
    return {
      id: n.id,
      type: 'sql',
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        ...n,
        accent: colorForJoin(n) ?? KIND_ACCENT[n.kind] ?? '#64748b',
      },
    }
  })

  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e-${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    label: e.label,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#94a3b8' },
    style: { stroke: '#94a3b8', strokeWidth: 1.5 },
    labelStyle: { fontSize: 9, fill: '#64748b' },
    labelBgStyle: { fill: 'var(--bg, #fff)', fillOpacity: 0.9 },
    labelBgPadding: [2, 4] as [number, number],
  }))

  return { nodes, edges }
}

type SqlNodeData = SqlGraphNode & {
  accent: string
  highlightedCols?: Set<string>
  selectedCol?: string | null
  onColumnClick?: (nodeId: string, column: string) => void
}

function SqlGraphNodeView({ id, data }: NodeProps) {
  const d = data as unknown as SqlNodeData
  const isJoin = d.kind === 'join'
  const isAgg = d.transforms?.includes('aggregate')
  const subtitle = isJoin
    ? (d.join_keys?.map(k => `${k.left_column}=${k.right_column}`).join(', ') || d.join_type || '')
    : isAgg
      ? 'cte · aggregate'
      : d.kind === 'parent'
        ? 'parent'
        : d.kind === 'output'
          ? 'output'
          : 'cte'

  const cols = d.columns ?? []
  const overflow = cols.length > MAX_VISIBLE_COLS
  const visibleCols = overflow ? cols.slice(0, MAX_VISIBLE_COLS - 1) : cols

  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-0 !h-0" />
      <div
        style={{
          width: isJoin ? JOIN_W : NODE_W,
          minHeight: isJoin ? JOIN_H : HEADER_H,
          borderRadius: 6,
          border: `1px solid var(--border, #e2e8f0)`,
          background: 'var(--bg, #fff)',
          boxShadow: d.kind === 'output' ? `0 0 0 2px ${d.accent}33` : undefined,
          overflow: 'hidden',
          fontSize: 11,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'stretch', minHeight: isJoin ? JOIN_H : HEADER_H }}>
          <div style={{ width: 4, background: d.accent, flexShrink: 0 }} />
          <div style={{ padding: '6px 8px', minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontWeight: 600,
                color: 'var(--text, #0f172a)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
              {isAgg && (
                <span
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: '#a16207',
                    background: '#fef3c7',
                    borderRadius: 3,
                    padding: '0 3px',
                    flexShrink: 0,
                  }}
                >
                  agg
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 9,
                color: 'var(--text-muted, #64748b)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {subtitle}
            </div>
          </div>
        </div>
        {!isJoin && visibleCols.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border, #e2e8f0)', padding: '2px 0' }}>
            {visibleCols.map(col => {
              const active = d.highlightedCols?.has(col)
              const selected = d.selectedCol === col
              return (
                <button
                  key={col}
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    d.onColumnClick?.(id, col)
                  }}
                  title={col}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: selected
                      ? `${PATH_COLOR}33`
                      : active
                        ? `${PATH_COLOR}18`
                        : 'transparent',
                    color: active || selected ? '#92400e' : 'var(--text, #0f172a)',
                    fontWeight: selected ? 700 : active ? 600 : 400,
                    fontSize: 10,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    padding: '2px 10px 2px 12px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    borderLeft: selected || active ? `2px solid ${PATH_COLOR}` : '2px solid transparent',
                  }}
                >
                  {col}
                </button>
              )
            })}
            {overflow && (
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--text-muted, #64748b)',
                  padding: '2px 12px',
                }}
              >
                +{cols.length - (MAX_VISIBLE_COLS - 1)} more
              </div>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-0 !h-0" />
    </>
  )
}

const nodeTypes: NodeTypes = { sql: SqlGraphNodeView }

function xformLabel(t: SqlGraphColumnDep['transformation']): string {
  switch (t) {
    case 'passthrough':
      return 'pass'
    case 'rename':
      return 'rename'
    case 'aggregated':
      return 'agg'
    case 'derived':
      return 'calc'
    default:
      return t
  }
}

interface CteFlowProps {
  graph: SqlGraph
}

export function CteFlow({ graph }: CteFlowProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph])
  const [selected, setSelected] = useState<{ nodeId: string; column: string } | null>(null)

  const path = useMemo(() => {
    if (!selected) return null
    return collectColumnPath(graph.column_lineage, selected.nodeId, selected.column)
  }, [graph.column_lineage, selected])

  const highlighted = path?.keys ?? new Set<string>()
  const pathEdges = path?.edgeKeys ?? new Set<string>()

  const onColumnClick = useCallback((nodeId: string, column: string) => {
    setSelected(prev =>
      prev?.nodeId === nodeId && prev.column === column ? null : { nodeId, column },
    )
  }, [])

  const nodes = useMemo(
    () =>
      layout.nodes.map(n => {
        const colsOnNode = new Set<string>()
        for (const key of highlighted) {
          const [nid, col] = key.split('\0')
          if (nid === n.id && col) colsOnNode.add(col)
        }
        const selCol =
          selected?.nodeId === n.id ? selected.column : null
        return {
          ...n,
          data: {
            ...n.data,
            highlightedCols: colsOnNode,
            selectedCol: selCol,
            onColumnClick,
          },
        }
      }),
    [layout.nodes, highlighted, selected, onColumnClick],
  )

  const edges = useMemo(
    () =>
      layout.edges.map(e => {
        const onPath = pathEdges.has(`${e.source}\0${e.target}`)
        return {
          ...e,
          style: {
            stroke: onPath ? PATH_COLOR : '#94a3b8',
            strokeWidth: onPath ? 2.5 : 1.5,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: onPath ? PATH_COLOR : '#94a3b8',
          },
          animated: onPath,
        }
      }),
    [layout.edges, pathEdges],
  )

  const labelOf = useCallback(
    (nodeId: string) => graph.nodes.find(n => n.id === nodeId)?.label ?? nodeId,
    [graph.nodes],
  )

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.15}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onPaneClick={() => setSelected(null)}
      >
        <Controls showInteractive={false} />
        <MiniMap
          nodeStrokeWidth={2}
          zoomable
          pannable
          style={{ background: 'var(--bg-surface, #f8fafc)' }}
        />
        <Background gap={16} size={1} color="var(--border, #e2e8f0)" />
      </ReactFlow>

      {selected && path && path.steps.length > 0 && (
        <div
          className="react-flow__panel"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 300,
            height: '100%',
            background: 'var(--bg, #fff)',
            borderLeft: '1px solid var(--border, #e2e8f0)',
            zIndex: 10,
            overflow: 'auto',
            padding: 16,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text, #0f172a)', lineHeight: 1.3 }}>
              Column path
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                color: 'var(--text-muted, #64748b)',
                flexShrink: 0,
                marginLeft: 8,
              }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div
            style={{
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--text, #0f172a)',
              marginBottom: 14,
              wordBreak: 'break-word',
            }}
          >
            {labelOf(selected.nodeId)}.<span style={{ color: PATH_COLOR }}>{selected.column}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {path.steps.map((step, i) => (
              <PathStepRow key={`${step.nodeId}-${step.column}-${i}`} step={step} labelOf={labelOf} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PathStepRow({
  step,
  labelOf,
}: {
  step: ColumnPathStep
  labelOf: (id: string) => string
}) {
  return (
    <div
      style={{
        fontSize: 12,
        background: 'var(--bg-surface, #f1f5f9)',
        borderRadius: 6,
        padding: '8px 10px',
      }}
    >
      <div style={{ color: 'var(--text-muted, #64748b)', fontSize: 10, marginBottom: 2 }}>
        {labelOf(step.nodeId)}
        {step.transformation && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 9,
              fontWeight: 700,
              textTransform: 'uppercase',
              color: '#92400e',
              background: '#fef3c7',
              borderRadius: 3,
              padding: '0 4px',
            }}
          >
            {xformLabel(step.transformation)}
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--text, #0f172a)',
          wordBreak: 'break-word',
        }}
      >
        {step.column}
      </div>
    </div>
  )
}

// Re-export for tests
export { colKey }
export type { SqlGraphColumnLineage }
