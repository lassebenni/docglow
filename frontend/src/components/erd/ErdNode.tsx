/**
 * ErdNode — renders one model card on the ERD canvas as a React Flow custom
 * node type (`nodeType: 'erdTable'`).
 *
 * Visual reference: `examples/erd-design-examples/erd-shared.jsx` (`TableNode`).
 * Custom-node + Handle pattern: `frontend/src/components/lineage/DagNode.tsx`.
 *
 * Behavior (origin requirements §5.1, §5.2):
 *   - Receives the resolved render-state via `data.effectiveState` (computed
 *     by `ErdCanvas` from default-state, per-node override, and the §5.2
 *     zero-keys downgrade). Threading state through `data` rather than
 *     reading it from the store directly is what makes the segmented control
 *     re-render every node uniformly (DOC-99 follow-up).
 *   - Click cycles the per-node state via `useErdStore.cycleNode`. Selection
 *     handling itself is owned by React Flow (`onNodeClick` on `<ReactFlow>`).
 *   - Body content depends on state: `compact` (header only), `keys` (only PK/FK rows),
 *     `full` (every column).
 *
 * React Flow integration:
 *   - Four generic header-level handles (`source-left`, `source-right`,
 *     `target-left`, `target-right`) so edges can attach on either side at
 *     the node midpoint — used for `compact`-state cards (header-only).
 *   - Per-column handles inside each `ColumnRow`
 *     (`source-left-${col}`, `source-right-${col}`, `target-left-${col}`,
 *     `target-right-${col}`) so edges in `keys` / `full` state visually
 *     anchor at the exact column row. Side selection still happens in
 *     `ErdCanvas` based on relative node positions.
 *   - Position is set on the wrapping React Flow node container — this
 *     component renders at (0, 0) inside it. No `position` / `left` / `top`
 *     in this file.
 */

import { useMemo, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useErdStore, type ErdNodeState } from '../../stores/erdStore'
import { computeKeyColumns } from '../../utils/erdKeys'
import { TABLE_W } from '../../utils/erdLayout'
import { ROW_H_COL } from '../../utils/erdNodeDimensions'

import type { DocglowColumn, DocglowModel, ErdRelationship } from '../../types'

export interface ErdNodeData {
  readonly model: DocglowModel
  /** Full top-level relationships list — used for key/FK detection. */
  readonly relationships: readonly ErdRelationship[]
  readonly selected?: boolean
  /**
   * Render state resolved by `ErdCanvas` (default-state / override / zero-keys
   * downgrade already applied). Threaded through `data` rather than read from
   * the store so React Flow's per-node memoization picks up changes uniformly
   * when the segmented control flips `defaultState` — bug-fix for DOC-99.
   */
  readonly effectiveState: ErdNodeState
  /**
   * Called with `model.unique_id` when the card is clicked. Optional —
   * React Flow's `onNodeClick` is the primary selection path; this is kept
   * for callers that don't route through React Flow (e.g. tests).
   */
  readonly onSelect?: (uid: string) => void
}

const MODEL_FILL = '#2563eb'

/** PK indicator color — amber, matches mockup. */
const PK_COLOR = '#d97706'

interface ColumnKeyFlags {
  readonly pk: boolean
  readonly fk: boolean
}

function computeColumnKeyFlags(
  model: DocglowModel,
  relationships: readonly ErdRelationship[],
): Map<string, ColumnKeyFlags> {
  const fkColumns = new Set<string>()
  for (const rel of relationships) {
    if (rel.from_unique_id === model.unique_id) {
      fkColumns.add(rel.from_column)
    }
  }
  const flags = new Map<string, ColumnKeyFlags>()
  for (const column of model.columns) {
    let hasUnique = false
    let hasNotNull = false
    for (const test of column.tests) {
      if (test.test_name === 'unique') hasUnique = true
      else if (test.test_name === 'not_null') hasNotNull = true
    }
    flags.set(column.name, {
      pk: hasUnique && hasNotNull,
      fk: fkColumns.has(column.name),
    })
  }
  return flags
}

interface ColumnRowProps {
  readonly column: DocglowColumn
  readonly flags: ColumnKeyFlags
  readonly isFirst: boolean
}

function ColumnRow({ column, flags, isFirst }: ColumnRowProps) {
  const indicator = flags.pk && flags.fk ? 'PK/FK' : flags.pk ? 'PK' : flags.fk ? 'FK' : ''
  const indicatorColor = flags.pk
    ? PK_COLOR
    : flags.fk
      ? 'var(--color-primary, #2563eb)'
      : 'var(--text-muted, #64748b)'
  return (
    <div
      className="flex items-center gap-2 px-2 text-xs"
      style={{
        height: ROW_H_COL,
        borderTop: isFirst ? 'none' : '1px solid var(--border, #e2e8f0)',
        background: flags.fk
          ? 'color-mix(in oklab, var(--color-primary, #2563eb) 5%, transparent)'
          : 'transparent',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        position: 'relative',
      }}
    >
      {/* Per-column handles — rendered as absolute children of the row, so
          their default vertical anchor is the row's centerline. Edges that
          reference these IDs visually attach to this exact column row. */}
      <Handle
        id={`target-left-${column.name}`}
        type="target"
        position={Position.Left}
        className="!opacity-0 !w-0 !h-0 !border-0 !bg-transparent"
        isConnectable={false}
      />
      <Handle
        id={`source-left-${column.name}`}
        type="source"
        position={Position.Left}
        className="!opacity-0 !w-0 !h-0 !border-0 !bg-transparent"
        isConnectable={false}
      />
      <Handle
        id={`target-right-${column.name}`}
        type="target"
        position={Position.Right}
        className="!opacity-0 !w-0 !h-0 !border-0 !bg-transparent"
        isConnectable={false}
      />
      <Handle
        id={`source-right-${column.name}`}
        type="source"
        position={Position.Right}
        className="!opacity-0 !w-0 !h-0 !border-0 !bg-transparent"
        isConnectable={false}
      />
      <span
        style={{
          color: indicatorColor,
          width: 28,
          fontSize: 9,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {indicator}
      </span>
      <span
        className="truncate"
        style={{ color: 'var(--text, #0f172a)', flex: 1, minWidth: 0 }}
      >
        {column.name}
      </span>
      {column.data_type && (
        <span
          className="ml-auto truncate"
          style={{
            color: 'var(--text-muted, #64748b)',
            fontSize: 10,
            maxWidth: 80,
          }}
        >
          {column.data_type}
        </span>
      )}
    </div>
  )
}

/**
 * React Flow custom node component. The `data` payload carries everything
 * the card needs; `position` is owned by React Flow.
 */
export function ErdNode({ data }: NodeProps) {
  const { model, relationships, selected, effectiveState, onSelect } =
    data as unknown as ErdNodeData

  const keyColumns = useMemo(
    () => computeKeyColumns(model, relationships),
    [model, relationships],
  )
  const columnFlags = useMemo(
    () => computeColumnKeyFlags(model, relationships),
    [model, relationships],
  )

  // Filter / order columns according to state. Both `keys` and `full` keep
  // the original `model.columns` order so the visual matches the schema.
  const visibleColumns = useMemo<readonly DocglowColumn[]>(() => {
    if (effectiveState === 'compact') return []
    if (effectiveState === 'keys') {
      return model.columns.filter((c) => keyColumns.has(c.name))
    }
    return model.columns
  }, [effectiveState, model.columns, keyColumns])

  // The cycle still happens here so the click on the card body cycles the
  // node state. React Flow's `onNodeClick` (wired in ErdCanvas) handles
  // canvas-level selection routing.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't stop propagation — React Flow needs the event to fire onNodeClick.
      useErdStore.getState().cycleNode(model.unique_id, keyColumns.size > 0)
      onSelect?.(model.unique_id)
      void e
    },
    [model.unique_id, keyColumns.size, onSelect],
  )

  const relationshipsCount = model.relationships_count ?? 0
  const headerBorderColor = selected ? '#f59e0b' : MODEL_FILL
  const cardBorderColor = selected ? '#f59e0b' : 'var(--border, #e2e8f0)'
  const cardBorderWidth = selected ? 2 : 1

  // Stable handle IDs let edges target either side of the node.
  // Visual handles are invisible — we only need the connection points.
  const handleClass = '!opacity-0 !w-0 !h-0 !border-0 !bg-transparent'

  return (
    <div
      onClick={handleClick}
      className="cursor-pointer select-none"
      style={{
        width: TABLE_W,
        background: 'var(--bg, #fff)',
        border: `${cardBorderWidth}px solid ${cardBorderColor}`,
        borderRadius: 6,
        boxShadow: selected
          ? '0 0 0 3px #f59e0b33, 0 0 12px #f59e0b44'
          : undefined,
      }}
      data-erd-node-id={model.unique_id}
    >
      {/* React Flow handles — both source + target on each side. */}
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className={handleClass}
        isConnectable={false}
      />
      <Handle
        id="source-left"
        type="source"
        position={Position.Left}
        className={handleClass}
        isConnectable={false}
      />
      <Handle
        id="target-right"
        type="target"
        position={Position.Right}
        className={handleClass}
        isConnectable={false}
      />
      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className={handleClass}
        isConnectable={false}
      />

      {/* Header */}
      <div
        className="flex items-center gap-2 px-2"
        style={{
          height: 36, // matches ROW_H_HEAD
          borderTop: `2px solid ${headerBorderColor}`,
          borderBottom:
            effectiveState === 'compact' ? 'none' : '1px solid var(--border, #e2e8f0)',
          borderTopLeftRadius: 5,
          borderTopRightRadius: 5,
        }}
      >
        <span
          className="inline-flex items-center justify-center rounded font-bold shrink-0"
          aria-label="model"
          style={{
            background: MODEL_FILL,
            color: 'white',
            width: 14,
            height: 14,
            fontSize: 9,
          }}
        >
          M
        </span>
        <span
          className="text-sm font-medium truncate"
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            color: 'var(--text, #0f172a)',
            flex: 1,
            minWidth: 0,
          }}
        >
          {model.name}
        </span>
        <span
          className="text-xs shrink-0"
          style={{
            color: 'var(--text-muted, #64748b)',
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          }}
        >
          {relationshipsCount > 0 ? `${relationshipsCount}↔` : '0'}
        </span>
      </div>

      {/* Body */}
      {effectiveState !== 'compact' && visibleColumns.length > 0 && (
        <div>
          {visibleColumns.map((column, i) => (
            <ColumnRow
              key={column.name}
              column={column}
              flags={columnFlags.get(column.name) ?? { pk: false, fk: false }}
              isFirst={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}
