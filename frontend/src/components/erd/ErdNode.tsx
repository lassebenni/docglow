/**
 * ErdNode — renders one model card on the ERD canvas.
 *
 * Visual reference: `examples/erd-design-examples/erd-shared.jsx` (`TableNode`).
 * Styling convention reference: `frontend/src/components/lineage/DagNode.tsx`.
 *
 * The mockup uses a lot of inline styles; we mirror its layout and dimensions
 * but use Tailwind utility classes + CSS variables (`var(--bg)`, etc.) for
 * theming, the same convention as the rest of the app.
 *
 * Behavior (origin requirements §5.1, §5.2):
 *   - Reads effective node-state from `useErdStore` (default-state OR per-node override).
 *   - Downgrades to `compact` if the model has zero key columns (§5.2 last paragraph).
 *   - Click anywhere on the card cycles the per-node state via `useErdStore.cycleNode`.
 *   - Body content depends on state: `compact` (header only), `keys` (only PK/FK rows),
 *     `full` (every column).
 *   - Caller positions the card absolutely; this component renders at its given
 *     `position.x` / `position.y`. The parent `<svg>` for edges sits in the same
 *     coordinate system (U3's responsibility).
 */

import { useMemo, useCallback } from 'react'
import { useErdStore } from '../../stores/erdStore'
import { computeKeyColumns } from '../../utils/erdKeys'
import { TABLE_W } from '../../utils/erdLayout'
import { ROW_H_COL } from '../../utils/erdNodeDimensions'

import type { DocglowColumn, DocglowModel } from '../../types'
import type { ErdRelationship } from '@docglow/shared-types'

export interface ErdNodeProps {
  readonly model: DocglowModel
  /** Full top-level relationships list — used for key/FK detection. */
  readonly relationships: readonly ErdRelationship[]
  readonly position: { readonly x: number; readonly y: number }
  readonly selected?: boolean
}

/**
 * Resource-letter pill ("M" for model). Mirrors the `ResourcePill` from the
 * mockup but uses the same blue tone the rest of the app uses for models
 * (see `RESOURCE_COLORS` in `DagNode.tsx`).
 */
const MODEL_FILL = '#2563eb'

/** PK indicator color — amber, matches mockup. */
const PK_COLOR = '#d97706'

/**
 * Compute per-column key flags (PK / FK) for the model.
 *
 * - PK = column has both a `unique` test AND a `not_null` test.
 * - FK = column appears as `from_column` of any outgoing relationship from this model.
 * - Both flags can be true simultaneously.
 */
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
      }}
    >
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

export function ErdNode({ model, relationships, position, selected }: ErdNodeProps) {
  const storeState = useErdStore((s) => s.getEffectiveState(model.unique_id))

  const keyColumns = useMemo(
    () => computeKeyColumns(model, relationships),
    [model, relationships],
  )
  const columnFlags = useMemo(
    () => computeColumnKeyFlags(model, relationships),
    [model, relationships],
  )

  // §5.2: zero-key models always render compact, regardless of default.
  const effectiveState = keyColumns.size === 0 ? 'compact' : storeState

  // Filter / order columns according to state. Both `keys` and `full` keep
  // the original `model.columns` order so the visual matches the schema.
  const visibleColumns = useMemo<readonly DocglowColumn[]>(() => {
    if (effectiveState === 'compact') return []
    if (effectiveState === 'keys') {
      return model.columns.filter((c) => keyColumns.has(c.name))
    }
    return model.columns
  }, [effectiveState, model.columns, keyColumns])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      useErdStore.getState().cycleNode(model.unique_id, keyColumns.size > 0)
    },
    [model.unique_id, keyColumns.size],
  )

  const relationshipsCount = model.relationships_count ?? 0
  const headerBorderColor = selected ? '#f59e0b' : MODEL_FILL
  const cardBorderColor = selected ? '#f59e0b' : 'var(--border, #e2e8f0)'
  const cardBorderWidth = selected ? 2 : 1

  return (
    <div
      onClick={handleClick}
      className="absolute cursor-pointer select-none"
      style={{
        left: position.x,
        top: position.y,
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
