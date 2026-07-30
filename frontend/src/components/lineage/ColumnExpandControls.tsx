import { useCallback, useEffect, useRef, useState } from 'react'
import { useColumnHighlightStore } from '../../stores/columnHighlightStore'

export const DEFAULT_EXPAND_ALL_CAP = 50
export const OVER_CAP_DETAIL_TEXT = 'Narrow the graph with filters or pinning to see more.'

export type LineageViewMode = 'table' | 'columns' | 'ctes'

/**
 * Pure helpers — exported for direct unit testing.
 * The component below is a thin render wrapper over these + the store.
 */

export function columnsModeTooltip(candidateCount: number): string | undefined {
  return candidateCount === 0 ? 'No column lineage data in this graph' : 'Show columns on nodes'
}

export function tableModeTooltip(): string {
  return 'Collapse to table-level lineage'
}

export function ctesModeTooltip(hasSqlGraph: boolean): string {
  return hasSqlGraph
    ? 'Show CTE / SQL graph for this model'
    : 'No CTE / SQL graph for this model'
}

export function shouldDisableColumnMode(candidateCount: number): boolean {
  return candidateCount === 0
}

export function shouldDisableCtesMode(hasSqlGraph: boolean): boolean {
  return !hasSqlGraph
}

export function formatOverCapHeadline(expanded: number, total: number): string {
  return `Expanded ${expanded} of ${total}`
}

interface ColumnExpandControlsProps {
  candidateIds: string[]
  cap?: number
  /** When true, CTEs mode is available (focus model has a sql_graph). */
  hasSqlGraph?: boolean
  mode?: LineageViewMode
  onModeChange?: (mode: LineageViewMode) => void
}

export function ColumnExpandControls({
  candidateIds,
  cap = DEFAULT_EXPAND_ALL_CAP,
  hasSqlGraph = false,
  mode: controlledMode,
  onModeChange,
}: ColumnExpandControlsProps) {
  const expandAll = useColumnHighlightStore(s => s.expandAll)
  const collapseAll = useColumnHighlightStore(s => s.collapseAll)

  const [uncontrolledMode, setUncontrolledMode] = useState<LineageViewMode>('table')
  const mode = controlledMode ?? uncontrolledMode
  const setMode = useCallback(
    (next: LineageViewMode) => {
      if (controlledMode === undefined) setUncontrolledMode(next)
      onModeChange?.(next)
    },
    [controlledMode, onModeChange],
  )

  const [overCap, setOverCap] = useState<{ expanded: number; total: number } | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const columnsDisabled = shouldDisableColumnMode(candidateIds.length)
  const ctesDisabled = shouldDisableCtesMode(hasSqlGraph)

  const applyColumnsMode = useCallback(() => {
    const result = expandAll(candidateIds, cap)
    setOverCap(result.total > cap ? result : null)
  }, [expandAll, candidateIds, cap])

  const applyTableMode = useCallback(() => {
    collapseAll(candidateIds)
    setOverCap(null)
  }, [collapseAll, candidateIds])

  // Re-apply expand when the visible candidate set changes while in columns mode
  // (e.g. depth/filter changes), so newly visible nodes get columns too.
  const candidateKey = candidateIds.join('\0')
  useEffect(() => {
    if (modeRef.current !== 'columns') return
    if (candidateIds.length === 0) {
      setMode('table')
      setOverCap(null)
      return
    }
    applyColumnsMode()
    // candidateKey tracks content changes; applyColumnsMode closes over the latest ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: re-run on candidate set change only
  }, [candidateKey])

  const handleSelect = useCallback(
    (next: LineageViewMode) => {
      if (next === 'columns' && columnsDisabled) return
      if (next === 'ctes' && ctesDisabled) return
      setMode(next)
      if (next === 'columns') {
        applyColumnsMode()
      } else {
        applyTableMode()
      }
    },
    [columnsDisabled, ctesDisabled, setMode, applyColumnsMode, applyTableMode],
  )

  const dismissToast = useCallback(() => {
    setOverCap(null)
  }, [])

  const buttonClasses = (active: boolean, isDisabled: boolean) =>
    `px-2 py-0.5 text-xs cursor-pointer transition-colors ${
      isDisabled
        ? 'opacity-50 cursor-not-allowed bg-[var(--bg)] text-[var(--text-muted)]'
        : active
          ? 'bg-primary text-white'
          : 'bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]'
    }`

  return (
    <>
      <div
        className="flex items-center rounded overflow-hidden border border-[var(--border)]"
        role="group"
        aria-label="Lineage detail level"
      >
        <button
          type="button"
          aria-label="Table-level lineage"
          aria-pressed={mode === 'table'}
          title={tableModeTooltip()}
          onClick={() => handleSelect('table')}
          className={buttonClasses(mode === 'table', false)}
        >
          Table
        </button>
        <button
          type="button"
          aria-label="Column-level lineage"
          aria-pressed={mode === 'columns'}
          title={columnsModeTooltip(candidateIds.length)}
          disabled={columnsDisabled}
          onClick={() => handleSelect('columns')}
          className={buttonClasses(mode === 'columns', columnsDisabled)}
        >
          Columns
        </button>
        <button
          type="button"
          aria-label="CTE SQL graph"
          aria-pressed={mode === 'ctes'}
          title={ctesModeTooltip(hasSqlGraph)}
          disabled={ctesDisabled}
          onClick={() => handleSelect('ctes')}
          className={buttonClasses(mode === 'ctes', ctesDisabled)}
        >
          CTEs
        </button>
      </div>
      {overCap && (
        <div
          role="status"
          aria-atomic="true"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 pl-4 pr-2 py-3 rounded-lg shadow-xl bg-[var(--bg-surface)] text-[var(--text)] border border-[var(--border)] max-w-[90vw]"
        >
          <svg
            width={20}
            height={20}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-primary shrink-0"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="flex flex-col">
            <span className="text-sm font-medium leading-tight">
              {formatOverCapHeadline(overCap.expanded, overCap.total)}
            </span>
            <span className="text-xs text-[var(--text-muted)] leading-tight mt-0.5">
              {OVER_CAP_DETAIL_TEXT}
            </span>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={dismissToast}
            className="ml-2 px-2.5 py-1 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg)] cursor-pointer transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
