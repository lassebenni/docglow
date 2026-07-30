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
  SqlGraphNode,
  SqlGraphOp,
  SqlGraphOpKind,
} from '../../types'
import { JOIN_KEY_PALETTE } from '../../utils/joinKeys'
import {
  columnExpression,
  strongestTransformation,
  transformationGlyph,
  transformationLabel,
} from '../../utils/columnTransforms'
import {
  collectColumnPath,
  type ColumnPathStep,
} from '../../utils/sqlGraphColumns'
import type { TransformationType } from '../../types'

const NODE_W = 188
const HEADER_H = 40
const COL_ROW_H = 18
const MAX_VISIBLE_COLS = 14
const JOIN_W = 140
const JOIN_H = 44
const OP_W = 128
const OP_H = 44
const PATH_COLOR = '#d97706'
const OP_ACCENT: Record<SqlGraphOpKind, string> = {
  filter: '#0d9488',
  case: '#db2777',
  window: '#7c3aed',
}

const KIND_ACCENT: Record<string, string> = {
  parent: '#16a34a',
  cte: '#7c3aed',
  join: '#2563eb',
  output: '#c2410c',
  op: '#db2777',
}

function nodeWidth(n: SqlGraphNode): number {
  if (n.kind === 'join') return JOIN_W
  if (n.kind === 'op') return OP_W
  return NODE_W
}

function nodeHeight(n: SqlGraphNode): number {
  if (n.kind === 'join') return JOIN_H
  if (n.kind === 'op') return OP_H
  const cols = n.columns?.length ?? 0
  const visible = Math.min(cols, MAX_VISIBLE_COLS)
  return HEADER_H + (visible > 0 ? visible * COL_ROW_H + 4 : 8)
}

/** Materialize expanded CTE ops into the layout graph. */
function expandGraph(
  graph: SqlGraph,
  expanded: Set<string>,
): { nodes: SqlGraphNode[]; edges: { source: string; target: string; label?: string }[] } {
  const nodes: SqlGraphNode[] = [...graph.nodes]
  const edges = graph.edges.map(e => ({ ...e }))
  const byId = new Map(nodes.map(n => [n.id, n]))

  for (const cteId of expanded) {
    const cte = byId.get(cteId)
    const ops = cte?.ops
    if (!cte || !ops?.length) continue

    for (const op of ops) {
      nodes.push({
        id: op.id,
        kind: 'op',
        label: op.label,
        expression: op.expression,
        op_kind: op.kind,
        columns: op.columns,
      })
    }

    const incoming = edges.filter(e => e.target === cteId)
    for (const e of incoming) {
      e.target = ops[0]!.id
    }
    for (let i = 0; i < ops.length - 1; i++) {
      edges.push({ source: ops[i]!.id, target: ops[i + 1]!.id })
    }
    edges.push({ source: ops[ops.length - 1]!.id, target: cteId })
  }

  return { nodes, edges }
}

function layoutGraph(
  graph: SqlGraph,
  expanded: Set<string>,
): { nodes: Node[]; edges: Edge[] } {
  const expandedGraph = expandGraph(graph, expanded)
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 72, marginx: 24, marginy: 24 })

  for (const n of expandedGraph.nodes) {
    g.setNode(n.id, { width: nodeWidth(n), height: nodeHeight(n) })
  }
  for (const e of expandedGraph.edges) {
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

  const nodes: Node[] = expandedGraph.nodes.map(n => {
    const pos = g.node(n.id)
    const w = nodeWidth(n)
    const h = nodeHeight(n)
    const accent =
      n.kind === 'op' && n.op_kind
        ? OP_ACCENT[n.op_kind]
        : (colorForJoin(n) ?? KIND_ACCENT[n.kind] ?? '#64748b')
    return {
      id: n.id,
      type: 'sql',
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { ...n, accent },
    }
  })

  const edges: Edge[] = expandedGraph.edges.map((e, i) => ({
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
  columnKinds?: Map<string, TransformationType>
  expanded?: boolean
  selectedOp?: boolean
  onColumnClick?: (nodeId: string, column: string) => void
  onToggleExpand?: (cteId: string) => void
  onOpClick?: (op: SqlGraphOp) => void
}

function SqlGraphNodeView({ id, data }: NodeProps) {
  const d = data as unknown as SqlNodeData
  const isJoin = d.kind === 'join'
  const isOp = d.kind === 'op'
  const isAgg = d.transforms?.includes('aggregate')
  const hasOps = (d.ops?.length ?? 0) > 0
  const subtitle = isOp
    ? (d.columns?.join(', ') || d.op_kind || 'op')
    : isJoin
      ? (d.join_keys?.map(k => `${k.left_column}=${k.right_column}`).join(', ') || d.join_type || '')
      : isAgg
        ? 'cte · aggregate'
        : d.kind === 'parent'
          ? 'parent'
          : d.kind === 'output'
            ? 'output'
            : hasOps
              ? `cte · ${d.ops!.length} op${d.ops!.length === 1 ? '' : 's'}`
              : 'cte'

  const cols = isOp ? [] : (d.columns ?? [])
  const overflow = cols.length > MAX_VISIBLE_COLS
  const visibleCols = overflow ? cols.slice(0, MAX_VISIBLE_COLS - 1) : cols
  const width = nodeWidth(d)

  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-0 !h-0" />
      <div
        role={isOp ? 'button' : undefined}
        tabIndex={isOp ? 0 : undefined}
        onClick={
          isOp
            ? e => {
                e.stopPropagation()
                d.onOpClick?.({
                  id: d.id,
                  kind: d.op_kind ?? 'case',
                  label: d.label,
                  expression: d.expression,
                  columns: d.columns,
                })
              }
            : undefined
        }
        onKeyDown={
          isOp
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  d.onOpClick?.({
                    id: d.id,
                    kind: d.op_kind ?? 'case',
                    label: d.label,
                    expression: d.expression,
                    columns: d.columns,
                  })
                }
              }
            : undefined
        }
        style={{
          width,
          minHeight: isJoin || isOp ? (isOp ? OP_H : JOIN_H) : HEADER_H,
          borderRadius: 6,
          border: d.selectedOp
            ? `1px solid ${PATH_COLOR}`
            : `1px solid var(--border, #e2e8f0)`,
          background: isOp ? `${d.accent}12` : 'var(--bg, #fff)',
          boxShadow: d.kind === 'output' ? `0 0 0 2px ${d.accent}33` : undefined,
          overflow: 'hidden',
          fontSize: 11,
          cursor: isOp ? 'pointer' : undefined,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            minHeight: isJoin || isOp ? (isOp ? OP_H : JOIN_H) : HEADER_H,
          }}
        >
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
              {hasOps && !isOp && (
                <button
                  type="button"
                  title={d.expanded ? 'Collapse CTE ops' : 'Expand CTE ops'}
                  onClick={e => {
                    e.stopPropagation()
                    d.onToggleExpand?.(id)
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    color: 'var(--text-muted, #64748b)',
                    fontSize: 10,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  {d.expanded ? '▼' : '▶'}
                </button>
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', textTransform: isOp ? 'uppercase' : undefined }}>
                {d.label}
              </span>
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
              {d.transforms?.includes('window') && !isOp && (
                <span
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: '#5b21b6',
                    background: '#ede9fe',
                    borderRadius: 3,
                    padding: '0 3px',
                    flexShrink: 0,
                  }}
                >
                  win
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
        {!isJoin && !isOp && visibleCols.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border, #e2e8f0)', padding: '2px 0' }}>
            {visibleCols.map(col => {
              const active = d.highlightedCols?.has(col)
              const selected = d.selectedCol === col
              const kind = d.columnKinds?.get(col)
              const glyph = transformationGlyph(kind)
              return (
                <button
                  key={col}
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    d.onColumnClick?.(id, col)
                  }}
                  title={kind ? `${col} · ${transformationLabel(kind)}` : col}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
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
                  {glyph && (
                    <span style={{ flexShrink: 0, color: '#b45309', fontWeight: 700 }}>{glyph}</span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{col}</span>
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

function toLineageDeps(deps: readonly SqlGraphColumnDep[] | undefined) {
  return (deps ?? []).map(d => ({
    source_model: d.source_node || undefined,
    source_column: d.source_column || undefined,
    transformation: d.transformation as TransformationType,
    expression: d.expression,
  }))
}

function columnKindsForNode(
  lineage: SqlGraph['column_lineage'],
  nodeId: string,
): Map<string, TransformationType> | undefined {
  const cols = lineage?.[nodeId]
  if (!cols) return undefined
  const map = new Map<string, TransformationType>()
  for (const [col, deps] of Object.entries(cols)) {
    const kind = strongestTransformation(toLineageDeps(deps))
    if (kind) map.set(col, kind)
  }
  return map.size > 0 ? map : undefined
}

interface CteFlowProps {
  graph: SqlGraph
}

export function CteFlow({ graph }: CteFlowProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<{ nodeId: string; column: string } | null>(null)
  const [selectedOp, setSelectedOp] = useState<SqlGraphOp | null>(null)

  const layout = useMemo(() => layoutGraph(graph, expanded), [graph, expanded])

  const path = useMemo(() => {
    if (!selected) return null
    return collectColumnPath(graph.column_lineage, selected.nodeId, selected.column)
  }, [graph.column_lineage, selected])

  const selectedFormula = useMemo(() => {
    if (!selected || !graph.column_lineage) return null
    const deps = graph.column_lineage[selected.nodeId]?.[selected.column]
    const direct = columnExpression(toLineageDeps(deps))
    if (direct) return direct
    return path?.steps.map(s => s.expression).find(Boolean) ?? null
  }, [selected, graph.column_lineage, path])

  const selectedKind = useMemo(() => {
    if (!selected || !graph.column_lineage) return null
    const deps = graph.column_lineage[selected.nodeId]?.[selected.column]
    const direct = strongestTransformation(toLineageDeps(deps))
    const pathKinds = (path?.steps ?? [])
      .map(s => s.transformation as TransformationType | undefined)
      .filter((t): t is TransformationType => Boolean(t))
    return strongestTransformation(
      [...(direct ? [{ transformation: direct }] : []), ...pathKinds.map(transformation => ({ transformation }))],
    )
  }, [selected, graph.column_lineage, path])

  const highlighted = path?.keys ?? new Set<string>()
  const pathEdges = path?.edgeKeys ?? new Set<string>()

  const onColumnClick = useCallback((nodeId: string, column: string) => {
    setSelectedOp(null)
    setSelected(prev =>
      prev?.nodeId === nodeId && prev.column === column ? null : { nodeId, column },
    )
  }, [])

  const onToggleExpand = useCallback((cteId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(cteId)) next.delete(cteId)
      else next.add(cteId)
      return next
    })
  }, [])

  const onOpClick = useCallback((op: SqlGraphOp) => {
    setSelected(null)
    setSelectedOp(prev => (prev?.id === op.id ? null : op))
  }, [])

  const nodes = useMemo(
    () =>
      layout.nodes.map(n => {
        const colsOnNode = new Set<string>()
        for (const key of highlighted) {
          const [nid, col] = key.split('\0')
          if (nid === n.id && col) colsOnNode.add(col)
        }
        const selCol = selected?.nodeId === n.id ? selected.column : null
        return {
          ...n,
          data: {
            ...n.data,
            highlightedCols: colsOnNode,
            selectedCol: selCol,
            columnKinds: columnKindsForNode(graph.column_lineage, n.id),
            expanded: expanded.has(n.id),
            selectedOp: selectedOp?.id === n.id,
            onColumnClick,
            onToggleExpand,
            onOpClick,
          },
        }
      }),
    [
      layout.nodes,
      highlighted,
      selected,
      onColumnClick,
      onToggleExpand,
      onOpClick,
      graph.column_lineage,
      expanded,
      selectedOp,
    ],
  )

  const edges = useMemo(
    () =>
      layout.edges.map(e => {
        const onPath = pathEdges.has(`${e.source}\0${e.target}`)
        return {
          ...e,
          label: e.source.startsWith('join:') ? undefined : e.label,
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

  const clearSelection = useCallback(() => {
    setSelected(null)
    setSelectedOp(null)
  }, [])

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
        onPaneClick={clearSelection}
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

      {selectedOp && (
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
              CTE op
            </div>
            <button
              type="button"
              onClick={() => setSelectedOp(null)}
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
          <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--text, #0f172a)' }}>
            <span style={{ color: 'var(--text-muted, #64748b)' }}>Kind </span>
            <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{selectedOp.kind}</span>
          </div>
          {selectedOp.columns && selectedOp.columns.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--text, #0f172a)' }}>
              <span style={{ color: 'var(--text-muted, #64748b)' }}>Columns </span>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {selectedOp.columns.join(', ')}
              </span>
            </div>
          )}
          {selectedOp.expression && (
            <div>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>Expression</div>
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-surface, #f1f5f9)',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text, #0f172a)',
                }}
              >
                {selectedOp.expression}
              </pre>
            </div>
          )}
        </div>
      )}

      {!selectedOp && selected && path && path.steps.length > 0 && (
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
              marginBottom: 10,
              wordBreak: 'break-word',
            }}
          >
            {labelOf(selected.nodeId)}.<span style={{ color: PATH_COLOR }}>{selected.column}</span>
          </div>
          {selectedKind && (
            <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--text, #0f172a)' }}>
              <span style={{ color: 'var(--text-muted, #64748b)' }}>Kind </span>
              {transformationGlyph(selectedKind)} {transformationLabel(selectedKind)}
            </div>
          )}
          {selectedFormula && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>Formula</div>
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-surface, #f1f5f9)',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text, #0f172a)',
                }}
              >
                {selectedFormula}
              </pre>
            </div>
          )}
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
  const glyph = transformationGlyph(step.transformation as TransformationType | undefined)
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
        {step.transformation && step.transformation !== 'passthrough' && (
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
            {glyph ? `${glyph} ` : ''}
            {transformationLabel(step.transformation as TransformationType)}
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
