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
  SqlGraphAggFn,
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
  collectColumnDownstream,
  collectColumnPath,
} from '../../utils/sqlGraphColumns'
import {
  aggFnGlyph,
  aggFnLabel,
  collapsePassthroughCtes,
  cteFilterOps,
  filterOpColumns,
  highlightSelectSqlLines,
  joinHighlightFromNode,
} from '../../utils/sqlGraphView'
import type { TransformationType } from '../../types'

const NODE_W = 188
const HEADER_H = 40
const COL_ROW_H = 18
const MAX_VISIBLE_COLS = 18
const JOIN_W = 140
const JOIN_H = 44
const PATH_COLOR = '#d97706'
const JOIN_HL_COLOR = '#2563eb'
const OP_ACCENT: Record<SqlGraphOpKind, string> = {
  filter: '#0d9488',
}
const FILT_COLOR = OP_ACCENT.filter


const KIND_ACCENT: Record<string, string> = {
  parent: '#16a34a',
  cte: '#7c3aed',
  join: '#2563eb',
  output: '#c2410c',
}

function nodeWidth(n: SqlGraphNode): number {
  if (n.kind === 'join') return JOIN_W
  return NODE_W
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
    g.setNode(n.id, { width: nodeWidth(n), height: nodeHeight(n) })
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
    const w = nodeWidth(n)
    const h = nodeHeight(n)
    const accent = colorForJoin(n) ?? KIND_ACCENT[n.kind] ?? '#64748b'
    return {
      id: n.id,
      type: 'sql',
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { ...n, accent },
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
  columnKinds?: Map<string, TransformationType>
  filterSelected?: boolean
  filterHighlightCols?: Set<string>
  joinHighlightCols?: Set<string>
  onColumnClick?: (nodeId: string, column: string) => void
  onFilterClick?: (cteId: string, ops: SqlGraphOp[]) => void
  onJoinClick?: (nodeId: string) => void
}

function columnTag(
  col: string,
  columnAgg: Readonly<Record<string, SqlGraphAggFn>> | undefined,
  kind: TransformationType | undefined,
): string | null {
  const agg = columnAgg?.[col]
  if (agg) return aggFnGlyph(agg)
  return transformationGlyph(kind)
}

function SqlGraphNodeView({ id, data }: NodeProps) {
  const d = data as unknown as SqlNodeData
  const isJoin = d.kind === 'join'
  const isAgg = d.transforms?.includes('aggregate')
  const isCte = d.kind === 'cte'
  const hasFilterOps = isCte && cteFilterOps(d).length > 0
  // Join cards activate the join panel; filters only via the FILT badge (avoid nested buttons).
  const clickable = isJoin
  const subtitle = isJoin
    ? (d.join_keys?.map(k => `${k.left_column}=${k.right_column}`).join(', ') || d.join_type || '')
    : isAgg
      ? 'cte · aggregate'
      : d.kind === 'parent'
        ? 'parent'
        : d.kind === 'output'
          ? 'output'
          : d.transforms?.includes('window')
            ? 'cte · window'
            : hasFilterOps
              ? 'cte · filtered'
              : 'cte'

  const cols = d.columns ?? []
  const overflow = cols.length > MAX_VISIBLE_COLS
  const visibleCols = overflow ? cols.slice(0, MAX_VISIBLE_COLS - 1) : cols
  const width = nodeWidth(d)

  const handleActivate = (e: { stopPropagation: () => void; preventDefault?: () => void }) => {
    e.stopPropagation()
    if (isJoin) d.onJoinClick?.(id)
  }

  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-0 !h-0" />
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? handleActivate : undefined}
        onKeyDown={
          clickable
            ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleActivate(e)
                }
              }
            : undefined
        }
        style={{
          width,
          minHeight: isJoin ? JOIN_H : HEADER_H,
          borderRadius: 6,
          border: d.filterSelected
            ? `1px solid ${FILT_COLOR}`
            : d.joinHighlightCols && isJoin
              ? `1px solid ${JOIN_HL_COLOR}`
              : `1px solid var(--border, #e2e8f0)`,
          background: 'var(--bg, #fff)',
          boxShadow: d.filterSelected
            ? `0 0 0 2px ${FILT_COLOR}33`
            : d.kind === 'output'
              ? `0 0 0 2px ${d.accent}33`
              : undefined,
          overflow: 'hidden',
          fontSize: 11,
          cursor: clickable ? 'pointer' : undefined,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            minHeight: isJoin ? JOIN_H : HEADER_H,
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
              {d.transforms?.includes('window') && (
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
              {hasFilterOps && (
                <span
                  role="button"
                  tabIndex={0}
                  title="View filter"
                  onClick={e => {
                    e.stopPropagation()
                    d.onFilterClick?.(id, cteFilterOps(d))
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      d.onFilterClick?.(id, cteFilterOps(d))
                    }
                  }}
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    color: '#fff',
                    background: FILT_COLOR,
                    borderRadius: 3,
                    padding: '0 3px',
                    flexShrink: 0,
                    cursor: 'pointer',
                  }}
                >
                  filt
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
              const joinHl = d.joinHighlightCols?.has(col)
              const filterHl = d.filterHighlightCols?.has(col)
              const kind = d.columnKinds?.get(col)
              const agg = d.column_agg?.[col]
              const glyph = columnTag(col, d.column_agg, kind)
              const titleBits = [
                col,
                agg ? aggFnLabel(agg) : kind ? transformationLabel(kind) : null,
              ].filter(Boolean)
              return (
                <button
                  key={col}
                  type="button"
                  data-cte-col={col}
                  onClick={e => {
                    e.stopPropagation()
                    d.onColumnClick?.(id, col)
                  }}
                  title={titleBits.join(' · ')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: selected
                      ? `${PATH_COLOR}33`
                      : joinHl
                        ? `${JOIN_HL_COLOR}22`
                        : filterHl
                          ? `${FILT_COLOR}22`
                          : active
                            ? `${PATH_COLOR}18`
                            : 'transparent',
                    color:
                      active || selected || joinHl || filterHl
                        ? joinHl && !selected && !active
                          ? '#1e40af'
                          : filterHl && !selected && !active && !joinHl
                            ? '#0f766e'
                            : '#92400e'
                        : 'var(--text, #0f172a)',
                    fontWeight: selected || joinHl || filterHl ? 700 : active ? 600 : 400,
                    fontSize: 10,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    padding: '2px 10px 2px 12px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    borderLeft: selected || active
                      ? `2px solid ${PATH_COLOR}`
                      : joinHl
                        ? `2px solid ${JOIN_HL_COLOR}`
                        : filterHl
                          ? `2px solid ${FILT_COLOR}`
                          : '2px solid transparent',
                  }}
                >
                  {glyph && (
                    <span
                      style={{
                        flexShrink: 0,
                        color: '#b45309',
                        fontWeight: 700,
                        fontSize: agg ? 8 : 10,
                        letterSpacing: agg ? '0.02em' : undefined,
                      }}
                    >
                      {glyph}
                    </span>
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
  const [showPassthrough, setShowPassthrough] = useState(false)
  const [selected, setSelected] = useState<{ nodeId: string; column: string } | null>(null)
  const [selectedFilter, setSelectedFilter] = useState<{ cteId: string; ops: SqlGraphOp[] } | null>(null)
  const [joinHl, setJoinHl] = useState<{ columns: Set<string>; nodeIds: Set<string> } | null>(null)

  const hasPassthrough = useMemo(
    () => graph.nodes.some(n => n.kind === 'cte' && n.passthrough),
    [graph.nodes],
  )

  const viewGraph = useMemo(
    () => (showPassthrough ? graph : collapsePassthroughCtes(graph)),
    [graph, showPassthrough],
  )

  const layout = useMemo(() => layoutGraph(viewGraph), [viewGraph])

  const path = useMemo(() => {
    if (!selected) return null
    return collectColumnPath(viewGraph.column_lineage, selected.nodeId, selected.column)
  }, [viewGraph.column_lineage, selected])

  const selectedFormula = useMemo(() => {
    if (!selected || !viewGraph.column_lineage) return null
    const deps = viewGraph.column_lineage[selected.nodeId]?.[selected.column]
    const direct = columnExpression(toLineageDeps(deps))
    if (direct) return direct
    return path?.steps.map(s => s.expression).find(Boolean) ?? null
  }, [selected, viewGraph.column_lineage, path])

  const selectedNode = useMemo(
    () =>
      selected
        ? (viewGraph.nodes.find(n => n.id === selected.nodeId)
          ?? graph.nodes.find(n => n.id === selected.nodeId)
          ?? null)
        : null,
    [selected, viewGraph.nodes, graph.nodes],
  )

  const selectedAggFn = selectedNode?.column_agg?.[selected?.column ?? ''] ?? null

  const selectedUpstream = useMemo(() => {
    if (!selected || !viewGraph.column_lineage) return []
    return viewGraph.column_lineage[selected.nodeId]?.[selected.column] ?? []
  }, [selected, viewGraph.column_lineage])

  /** old → new when this CTE field is a rename at the selected node */
  const selectedRename = useMemo(() => {
    if (!selected) return null
    const renameDep = selectedUpstream.find(d => d.transformation === 'rename' && d.source_column)
    if (!renameDep?.source_column) return null
    if (renameDep.source_column === selected.column) return null
    return { oldName: renameDep.source_column, newName: selected.column }
  }, [selected, selectedUpstream])

  const selectedDownstream = useMemo(() => {
    if (!selected) return []
    return collectColumnDownstream(viewGraph.column_lineage, selected.nodeId, selected.column)
  }, [selected, viewGraph.column_lineage])

  const selectSqlLines = useMemo(() => {
    if (!selected || !selectedNode?.select_sql) return null
    return highlightSelectSqlLines(selectedNode.select_sql, selected.column)
  }, [selected, selectedNode])

  const selectedKind = useMemo(() => {
    if (!selected || !viewGraph.column_lineage) return null
    if (selectedAggFn) return null
    const deps = viewGraph.column_lineage[selected.nodeId]?.[selected.column]
    const direct = strongestTransformation(toLineageDeps(deps))
    const pathKinds = (path?.steps ?? [])
      .map(s => s.transformation as TransformationType | undefined)
      .filter((t): t is TransformationType => Boolean(t))
    return strongestTransformation(
      [...(direct ? [{ transformation: direct }] : []), ...pathKinds.map(transformation => ({ transformation }))],
    )
  }, [selected, viewGraph.column_lineage, path, selectedAggFn])

  // WHERE/HAVING apply to the CTE row set — show on every column of that node.
  const selectedFilters = useMemo(() => {
    if (!selected || !selectedNode) return []
    return cteFilterOps(selectedNode)
  }, [selected, selectedNode])

  const highlighted = path?.keys ?? new Set<string>()
  const pathEdges = path?.edgeKeys ?? new Set<string>()

  const onColumnClick = useCallback(
    (nodeId: string, column: string) => {
      setJoinHl(null)
      setSelectedFilter(null)
      setSelected(prev =>
        prev?.nodeId === nodeId && prev.column === column
          ? null
          : { nodeId, column },
      )
    },
    [],
  )

  const onFilterClick = useCallback((cteId: string, ops: SqlGraphOp[]) => {
    setSelected(null)
    setJoinHl(null)
    setSelectedFilter(prev => (prev?.cteId === cteId ? null : { cteId, ops }))
  }, [])

  const onJoinClick = useCallback(
    (nodeId: string) => {
      setSelected(null)
      setSelectedFilter(null)
      const joinNode = viewGraph.nodes.find(n => n.id === nodeId)
      if (!joinNode) return
      const hl = joinHighlightFromNode(viewGraph, joinNode)
      setJoinHl(prev => (prev && [...prev.nodeIds].includes(nodeId) ? null : hl))
    },
    [viewGraph],
  )

  const nodes = useMemo(
    () =>
      layout.nodes.map(n => {
        const colsOnNode = new Set<string>()
        for (const key of highlighted) {
          const [nid, col] = key.split('\0')
          if (nid === n.id && col) colsOnNode.add(col)
        }
        const selCol = selected?.nodeId === n.id ? selected.column : null
        const joinCols = joinHl && joinHl.nodeIds.has(n.id) ? joinHl.columns : undefined
        const filterCols = selectedFilter?.cteId === n.id ? filterOpColumns(selectedFilter.ops) : undefined
        return {
          ...n,
          data: {
            ...n.data,
            highlightedCols: colsOnNode,
            selectedCol: selCol,
            columnKinds: columnKindsForNode(viewGraph.column_lineage, n.id),
            filterSelected: selectedFilter?.cteId === n.id,
            filterHighlightCols: filterCols,
            joinHighlightCols: joinCols,
            onColumnClick,
            onFilterClick,
            onJoinClick,
          },
        }
      }),
    [
      layout.nodes,
      highlighted,
      selected,
      onColumnClick,
      onFilterClick,
      onJoinClick,
      viewGraph.column_lineage,
      selectedFilter,
      joinHl,
    ],
  )

  const edges = useMemo(
    () =>
      layout.edges.map(e => {
        const onPath = pathEdges.has(`${e.source}\0${e.target}`)
        const onJoin =
          Boolean(joinHl)
          && joinHl!.nodeIds.has(e.source)
          && joinHl!.nodeIds.has(e.target)
        return {
          ...e,
          label: e.source.startsWith('join:') ? undefined : e.label,
          style: {
            stroke: onPath ? PATH_COLOR : onJoin ? JOIN_HL_COLOR : '#94a3b8',
            strokeWidth: onPath || onJoin ? 2.5 : 1.5,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color: onPath ? PATH_COLOR : onJoin ? JOIN_HL_COLOR : '#94a3b8',
          },
          animated: onPath,
        }
      }),
    [layout.edges, pathEdges, joinHl],
  )

  const labelOf = useCallback(
    (nodeId: string) =>
      viewGraph.nodes.find(n => n.id === nodeId)?.label
      ?? graph.nodes.find(n => n.id === nodeId)?.label
      ?? nodeId,
    [viewGraph.nodes, graph.nodes],
  )

  const clearSelection = useCallback(() => {
    setSelected(null)
    setSelectedFilter(null)
    setJoinHl(null)
  }, [])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {hasPassthrough && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--bg, #fff)',
            border: '1px solid var(--border, #e2e8f0)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 11,
            color: 'var(--text, #0f172a)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showPassthrough}
              onChange={e => setShowPassthrough(e.target.checked)}
            />
            Show passthrough CTEs
          </label>
        </div>
      )}
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

      {selectedFilter && (
        <div
          className="react-flow__panel"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 320,
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
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text, #0f172a)', lineHeight: 1.3 }}>
                Filter
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted, #64748b)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {labelOf(selectedFilter.cteId)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedFilter(null)}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {selectedFilter.ops.map(op => (
              <div key={op.id}>
                <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text, #0f172a)' }}>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: '#fff',
                      background: FILT_COLOR,
                      borderRadius: 3,
                      padding: '1px 5px',
                    }}
                  >
                    {op.label}
                  </span>
                </div>
                {op.expression && (
                  <pre
                    style={{
                      margin: 0,
                      marginBottom: op.columns?.length ? 6 : 0,
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
                    {op.expression}
                  </pre>
                )}
                {op.columns && op.columns.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted, #64748b)' }}>
                    Columns{' '}
                    <span
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: 'var(--text, #0f172a)',
                      }}
                    >
                      {op.columns.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!selectedFilter && selected && (
        <div
          className="react-flow__panel"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 320,
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
              Column
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
          {(selectedAggFn || selectedKind) && (
            <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--text, #0f172a)' }}>
              <span style={{ color: 'var(--text-muted, #64748b)' }}>Kind </span>
              {selectedAggFn
                ? (
                  <>
                    <span style={{ fontWeight: 700, color: '#a16207' }}>{aggFnGlyph(selectedAggFn)}</span>
                    {' '}
                    {aggFnLabel(selectedAggFn)}
                  </>
                )
                : (
                  <>
                    {transformationGlyph(selectedKind)} {transformationLabel(selectedKind)}
                  </>
                )}
            </div>
          )}
          {selectedRename && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>
                Rename
              </div>
              <div
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'var(--bg-surface, #f1f5f9)',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: 'var(--text, #0f172a)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span>{selectedRename.oldName}</span>
                <span style={{ color: PATH_COLOR, fontWeight: 700 }}>→</span>
                <span style={{ color: PATH_COLOR, fontWeight: 700 }}>{selectedRename.newName}</span>
              </div>
            </div>
          )}
          {selectedFilters.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>
                Filtered by
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedFilters.map(op => (
                  <div
                    key={op.id}
                    style={{
                      fontSize: 12,
                      background: 'var(--bg-surface, #f1f5f9)',
                      borderRadius: 6,
                      padding: '8px 10px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: '#fff',
                        background: FILT_COLOR,
                        borderRadius: 3,
                        padding: '1px 5px',
                        marginRight: 6,
                      }}
                    >
                      {op.label}
                    </span>
                    {' '}
                    {op.expression && (
                      <span
                        style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          color: 'var(--text, #0f172a)',
                        }}
                      >
                        {op.expression}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {selectSqlLines && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>
                CTE select
              </div>
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
                  lineHeight: 1.45,
                }}
              >
                {selectSqlLines.map((line, i) => (
                  <div
                    key={i}
                    style={
                      line.highlight
                        ? {
                            background: `${PATH_COLOR}33`,
                            borderLeft: `2px solid ${PATH_COLOR}`,
                            marginLeft: -6,
                            paddingLeft: 4,
                            borderRadius: 2,
                          }
                        : undefined
                    }
                  >
                    {line.text || ' '}
                  </div>
                ))}
              </pre>
            </div>
          )}
          {!selectSqlLines && selectedFormula && (
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
          {selectedUpstream.length > 0 && (
            <div style={{ marginBottom: selectedDownstream.length > 0 ? 14 : 0 }}>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>
                Upstream
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedUpstream.map((dep, i) => (
                  <div
                    key={`${dep.source_node}-${dep.source_column}-${i}`}
                    style={{
                      fontSize: 12,
                      background: 'var(--bg-surface, #f1f5f9)',
                      borderRadius: 6,
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ color: 'var(--text-muted, #64748b)', fontSize: 10, marginBottom: 2 }}>
                      {dep.source_node ? labelOf(dep.source_node) : '—'}
                    </div>
                    <div
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: 'var(--text, #0f172a)',
                      }}
                    >
                      {dep.source_column || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {selectedDownstream.length > 0 && (
            <div>
              <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6, fontSize: 12 }}>
                Downstream
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {selectedDownstream.map((dep, i) => (
                  <div
                    key={`${dep.nodeId}-${dep.column}-${i}`}
                    style={{
                      fontSize: 12,
                      background: 'var(--bg-surface, #f1f5f9)',
                      borderRadius: 6,
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ color: 'var(--text-muted, #64748b)', fontSize: 10, marginBottom: 2 }}>
                      {labelOf(dep.nodeId)}
                    </div>
                    <div
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        color: 'var(--text, #0f172a)',
                      }}
                    >
                      {dep.column}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

