import { memo, useCallback, useMemo, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useColumnHighlightStore } from '../../stores/columnHighlightStore'
import { FIELD_LINEAGE_EDGE_COLOR } from '../../utils/columnTransforms'
import { joinRoleBadgeTitle } from '../../utils/joinKeys'
import { transformationGlyph } from '../../utils/columnTransforms'
import type { TransformationType } from '../../types'

const RESOURCE_COLORS: Record<string, string> = {
  model: '#2563eb',
  source: '#16a34a',
  seed: '#6b7280',
  snapshot: '#7c3aed',
  exposure: '#d97706',
  metric: '#7c3aed',
}

const TEST_STATUS_BORDER: Record<string, string> = {
  pass: '#16a34a',
  fail: '#dc2626',
  warn: '#d97706',
  none: 'transparent',
}

const COLUMN_ROW_HEIGHT = 22
const MAX_VISIBLE_COLUMNS = 20
/** Field-path / selected-column highlight — same amber as lineage edges. */
const AMBER = FIELD_LINEAGE_EDGE_COLOR

/**
 * Order columns for a DAG node.
 *
 * - Clicked/selected node: keep catalog order (clicking a field must not jump it to top).
 * - Parent nodes on a field path: promote matched fields to the top only when at least
 *   one match sits below the visible scroll window (index ≥ maxVisible).
 */
export function orderDagNodeColumns(
  columns: readonly string[],
  highlightedColumns: ReadonlySet<string> | undefined,
  options: { isSelectedNode: boolean; maxVisible?: number },
): string[] {
  const cols = [...columns]
  const maxVisible = options.maxVisible ?? MAX_VISIBLE_COLUMNS

  if (highlightedColumns) {
    const byLower = new Map(cols.map((c) => [c.toLowerCase(), c]))
    for (const h of highlightedColumns) {
      if (!byLower.has(h.toLowerCase())) {
        byLower.set(h.toLowerCase(), h)
        cols.push(h)
      }
    }
  }

  // Selected node: never reorder on click / self-highlight.
  if (options.isSelectedNode || !highlightedColumns?.size) return cols

  const isHot = (col: string) => {
    if (highlightedColumns.has(col)) return true
    const lower = col.toLowerCase()
    for (const h of highlightedColumns) {
      if (h.toLowerCase() === lower) return true
    }
    return false
  }

  const hotIndices: number[] = []
  for (let i = 0; i < cols.length; i++) {
    if (isHot(cols[i]!)) hotIndices.push(i)
  }
  if (hotIndices.length === 0) return cols

  // Already in the first screenful — leave catalog order alone.
  if (hotIndices.every((i) => i < maxVisible)) return cols

  const hot: string[] = []
  const rest: string[] = []
  for (const col of cols) {
    if (isHot(col)) hot.push(col)
    else rest.push(col)
  }
  return [...hot, ...rest]
}

export interface DagNodeData {
  name: string
  resource_type: string
  materialization: string
  test_status: string
  isActive: boolean
  folder?: string
  schema?: string
  columns?: string[]
  hasColumnLineage?: boolean
  autoExpanded?: boolean
  /** Map of column names that should be highlighted in the column trace */
  highlightedColumns?: Set<string>
  /** Per-column colors for multi-branch field paths (model-local column → color) */
  fieldPathColumnColors?: Map<string, string>
  /** Ambient join-key highlights: column → relationship color */
  joinKeyColors?: Map<string, string>
  /** Ambient transformation kinds for column glyphs */
  columnKinds?: Map<string, TransformationType>
  /** FROM (foundation) parent for the focused model's JOIN block */
  isJoinBase?: boolean
  /** Compact JOIN type on a non-base parent (LEFT / INNER / …) */
  joinTypeBadge?: string
  /** Whether this node participates in a column trace (for amber border on collapsed nodes) */
  inColumnTrace?: boolean
  /** Node is in the lineage chain but has no column lineage data */
  noColumnData?: boolean
  [key: string]: unknown
}

function DagNodeComponent({ data, id }: NodeProps) {
  const {
    name,
    resource_type,
    materialization,
    test_status,
    isActive,
    folder,
    schema,
    columns,
    hasColumnLineage,
    highlightedColumns,
    fieldPathColumnColors,
    joinKeyColors,
    columnKinds,
    isJoinBase,
    joinTypeBadge,
    inColumnTrace,
    noColumnData,
  } = data as DagNodeData

  const { autoExpanded } = data as DagNodeData
  const isManuallyExpanded = useColumnHighlightStore(s => s.expandedNodeIds.has(id))
  const isManuallyCollapsed = useColumnHighlightStore(s => s.manuallyCollapsedIds.has(id))
  const isExpanded = isManuallyExpanded || (!!autoExpanded && !isManuallyCollapsed)
  const isThisSelected = useColumnHighlightStore(
    s => s.selectedColumn?.modelId === id
  )
  const selectedColumnName = useColumnHighlightStore(
    s => s.selectedColumn?.modelId === id ? s.selectedColumn.columnName : null
  )
  const toggleNodeExpanded = useColumnHighlightStore(s => s.toggleNodeExpanded)
  const selectColumn = useColumnHighlightStore(s => s.selectColumn)

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    toggleNodeExpanded(id)
  }, [id, toggleNodeExpanded])

  const handleColumnClick = useCallback((e: React.MouseEvent, colName: string) => {
    e.stopPropagation()
    selectColumn(id, colName)
  }, [id, selectColumn])

  const fill = RESOURCE_COLORS[resource_type] ?? '#6b7280'
  const borderColor = TEST_STATUS_BORDER[test_status] ?? 'transparent'

  const showAmberBorder = isActive || inColumnTrace
  const border = showAmberBorder
    ? `2.5px solid ${AMBER}`
    : noColumnData
      ? `2px dashed ${AMBER}88`
      : borderColor !== 'transparent'
        ? `2px solid ${borderColor}`
        : '1px solid var(--border, #e2e8f0)'

  const boxShadow = showAmberBorder
    ? `0 0 0 3px ${AMBER}33, 0 0 12px ${AMBER}44`
    : noColumnData
      ? `0 0 0 2px ${AMBER}22`
      : undefined

  const tooltipText = [schema && `Schema: ${schema}`, folder && `Folder: ${folder}`].filter(Boolean).join('\n')
  const canExpand = hasColumnLineage && columns && columns.length > 0

  const allColumns = useMemo(() => {
    const base = [...(columns ?? [])]
    if (selectedColumnName && !base.some((c) => c.toLowerCase() === selectedColumnName.toLowerCase())) {
      base.push(selectedColumnName)
    }
    return orderDagNodeColumns(base, highlightedColumns, {
      isSelectedNode: isThisSelected,
      maxVisible: MAX_VISIBLE_COLUMNS,
    })
  }, [columns, highlightedColumns, selectedColumnName, isThisSelected])

  const columnsContainerRef = useRef<HTMLDivElement>(null)
  // Parent nodes only: scroll a matched field into view when it was promoted or
  // sits near the fold. Never jump scroll on the node the user is clicking in.
  useEffect(() => {
    if (isThisSelected || !isExpanded || !highlightedColumns?.size) return
    const root = columnsContainerRef.current
    if (!root) return
    const firstHot = root.querySelector('[data-col-hot="1"]') as HTMLElement | null
    firstHot?.scrollIntoView({ block: 'nearest' })
  }, [isThisSelected, isExpanded, highlightedColumns])

  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-0 !h-0" />
      <div
        className="dag-node-container"
        title={tooltipText || undefined}
        style={{
          width: 180,
          borderRadius: 6,
          border,
          boxShadow,
          background: showAmberBorder ? 'var(--bg, #fff)' : 'var(--bg, #fff)',
          overflow: 'visible',
          cursor: 'pointer',
          position: 'relative',
        }}
      >
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'stretch', height: 44 }}>
          <div style={{ width: 4, background: fill, flexShrink: 0 }} />
          <div style={{ padding: '4px 8px', overflow: 'hidden', minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12,
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
              {isJoinBase && (
                <span
                  title="FROM parent — other parents join into this model"
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted, #64748b)',
                    background: 'var(--bg-muted, #f1f5f9)',
                    border: '1px solid var(--border, #e2e8f0)',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    flexShrink: 0,
                  }}
                >
                  Base
                </span>
              )}
              {!isJoinBase && joinTypeBadge && (
                <span
                  title={joinRoleBadgeTitle(joinTypeBadge)}
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted, #64748b)',
                    background: 'var(--bg-muted, #f1f5f9)',
                    border: '1px solid var(--border, #e2e8f0)',
                    borderRadius: 3,
                    padding: '0 4px',
                    lineHeight: '14px',
                    flexShrink: 0,
                  }}
                >
                  {joinTypeBadge}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-muted, #64748b)',
                whiteSpace: 'nowrap',
              }}
            >
              {resource_type}{materialization ? ` · ${materialization}` : ''}
            </div>
          </div>
          {/* Expand chevron */}
          {canExpand && (
            <button
              onClick={handleExpandClick}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0 6px',
                color: 'var(--text-muted, #64748b)',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
              title={isExpanded ? 'Hide columns' : 'Show columns'}
            >
              <svg
                width={10}
                height={10}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                style={{
                  transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease',
                }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}
        </div>

        {/* Expanded column list */}
        {isExpanded && columns && (
          <div
            ref={columnsContainerRef}
            className="dag-node-columns nowheel nodrag"
            style={{
              borderTop: '1px solid var(--border, #e2e8f0)',
              border: '1px solid var(--border, #e2e8f0)',
              borderRadius: '0 0 6px 6px',
              maxHeight: MAX_VISIBLE_COLUMNS * COLUMN_ROW_HEIGHT + 4,
              overflowY: 'auto',
              overflowX: 'hidden',
              background: 'var(--bg, #fff)',
              position: 'relative',
              zIndex: 20,
              boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            }}
          >
            {allColumns.map((col) => {
              const isSelected = isThisSelected && selectedColumnName === col
              const joinColor = joinKeyColors?.get(col)
              const pathColor = (() => {
                if (!fieldPathColumnColors?.size) return undefined
                if (fieldPathColumnColors.has(col)) return fieldPathColumnColors.get(col)
                const lower = col.toLowerCase()
                for (const [key, color] of fieldPathColumnColors) {
                  if (key.toLowerCase() === lower) return color
                }
                return undefined
              })()
              const isTraceHighlighted = (() => {
                if (!highlightedColumns) return false
                if (highlightedColumns.has(col)) return true
                const lower = col.toLowerCase()
                for (const h of highlightedColumns) {
                  if (h.toLowerCase() === lower) return true
                }
                return false
              })()
              const isHighlighted = isTraceHighlighted || !!joinColor || !!pathColor
              const highlightColor = isSelected
                ? AMBER
                : (pathColor ?? (isTraceHighlighted ? AMBER : (joinColor ?? AMBER)))
              const colBg = isSelected
                ? `${AMBER}30`
                : isHighlighted
                  ? `${highlightColor}18`
                  : 'transparent'
              const kind = columnKinds?.get(col)
              const glyph = transformationGlyph(kind)

              return (
                <div
                  key={col}
                  id={`col-${col}`}
                  data-col-hot={isTraceHighlighted || isSelected ? '1' : undefined}
                  onClick={(e) => handleColumnClick(e, col)}
                  style={{
                    height: COLUMN_ROW_HEIGHT,
                    padding: '0 8px 0 12px',
                    fontSize: 10,
                    color: isSelected || isHighlighted ? highlightColor : 'var(--text, #0f172a)',
                    fontWeight: isSelected ? 600 : 400,
                    background: colBg,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    position: 'relative',
                    transition: 'background 0.1s ease',
                  }}
                  title={kind ? `${col} · ${kind}` : col}
                >
                  {glyph && (
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        fontSize: kind === 'constant' ? 8 : 10,
                        fontWeight: 700,
                        color: 'var(--text-muted, #94a3b8)',
                        minWidth: kind === 'constant' ? 16 : 10,
                        letterSpacing: kind === 'constant' ? '0.02em' : undefined,
                        textAlign: 'center',
                        opacity: 0.85,
                      }}
                    >
                      {glyph}
                    </span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{col}</span>
                  {/* Per-column handles for edge connections */}
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={`col-${col}-target`}
                    className="!opacity-0 !w-0 !h-0"
                    style={{ top: '50%' }}
                  />
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`col-${col}-source`}
                    className="!opacity-0 !w-0 !h-0"
                    style={{ top: '50%' }}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Tooltip via native title — no React state, no re-renders */}
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-0 !h-0" />
    </>
  )
}

export const DagNode = memo(DagNodeComponent)
