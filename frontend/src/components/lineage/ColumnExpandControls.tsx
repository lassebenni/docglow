import { useCallback, useState } from 'react'
import { useColumnHighlightStore } from '../../stores/columnHighlightStore'

export const DEFAULT_EXPAND_ALL_CAP = 50
export const OVER_CAP_DETAIL_TEXT = 'Narrow the graph with filters or pinning to see more.'

/**
 * Pure helpers — exported for direct unit testing.
 * The component below is a thin render wrapper over these + the store.
 */

export function expandTooltip(candidateCount: number): string | undefined {
  return candidateCount === 0 ? 'No column lineage data in this graph' : undefined
}

export function collapseTooltip(candidateCount: number): string | undefined {
  return candidateCount === 0 ? 'Nothing to collapse' : undefined
}

export function shouldDisableExpandAll(candidateCount: number): boolean {
  return candidateCount === 0
}

// Collapse-all is enabled whenever there are candidates that could be expanded
// (manually or by the local auto-expand memo in LineageFlow). The store cannot
// know whether the memo is currently auto-expanding nodes, so we use the
// candidate count as the proxy. Clicking on an already-empty view is a no-op.
export function shouldDisableCollapseAll(candidateCount: number): boolean {
  return candidateCount === 0
}

export function formatOverCapHeadline(expanded: number, total: number): string {
  return `Expanded ${expanded} of ${total}`
}

interface ColumnExpandControlsProps {
  candidateIds: string[]
  cap?: number
}

export function ColumnExpandControls({
  candidateIds,
  cap = DEFAULT_EXPAND_ALL_CAP,
}: ColumnExpandControlsProps) {
  const expandAll = useColumnHighlightStore(s => s.expandAll)
  const collapseAll = useColumnHighlightStore(s => s.collapseAll)

  const [overCap, setOverCap] = useState<{ expanded: number; total: number } | null>(null)

  const expandDisabled = shouldDisableExpandAll(candidateIds.length)
  const collapseDisabled = shouldDisableCollapseAll(candidateIds.length)

  const handleExpand = useCallback(() => {
    const result = expandAll(candidateIds, cap)
    setOverCap(result.total > cap ? result : null)
  }, [expandAll, candidateIds, cap])

  const handleCollapse = useCallback(() => {
    collapseAll(candidateIds)
    setOverCap(null)
  }, [collapseAll, candidateIds])

  const dismissToast = useCallback(() => {
    setOverCap(null)
  }, [])

  const buttonClasses = (disabled: boolean) =>
    `px-2 py-0.5 text-xs cursor-pointer transition-colors rounded border border-[var(--border)] ${
      disabled
        ? 'opacity-50 cursor-not-allowed bg-[var(--bg)] text-[var(--text-muted)]'
        : 'bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]'
    }`

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Expand columns on all nodes"
          title={expandTooltip(candidateIds.length)}
          disabled={expandDisabled}
          onClick={handleExpand}
          className={buttonClasses(expandDisabled)}
        >
          Expand all
        </button>
        <button
          type="button"
          aria-label="Collapse columns on all nodes"
          title={collapseTooltip(candidateIds.length)}
          disabled={collapseDisabled}
          onClick={handleCollapse}
          className={buttonClasses(collapseDisabled)}
        >
          Collapse all
        </button>
      </div>
      {overCap && (
        <div
          role="status"
          aria-atomic="true"
          // Fixed-position toast pinned to the bottom-center of the viewport.
          // Dismissed by the close button or by the next bulk action click.
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
