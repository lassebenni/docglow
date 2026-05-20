import { useCallback, useEffect, useRef, useState } from 'react'
import { useColumnHighlightStore } from '../../stores/columnHighlightStore'

export const DEFAULT_EXPAND_ALL_CAP = 50
export const OVER_CAP_TOAST_DURATION_MS = 6000

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

export function formatOverCapMessage(expanded: number, total: number): string {
  return `Expanded ${expanded} of ${total} — narrow the graph with filters or pinning to see more.`
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
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const expandDisabled = shouldDisableExpandAll(candidateIds.length)
  const collapseDisabled = shouldDisableCollapseAll(candidateIds.length)

  const dismissToast = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    setOverCap(null)
  }, [])

  const showToast = useCallback((result: { expanded: number; total: number }) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    setOverCap(result)
    dismissTimerRef.current = setTimeout(() => {
      setOverCap(null)
      dismissTimerRef.current = null
    }, OVER_CAP_TOAST_DURATION_MS)
  }, [])

  // Clear any pending timer if the component unmounts so we do not setState
  // on a dead component.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [])

  const handleExpand = useCallback(() => {
    const result = expandAll(candidateIds, cap)
    if (result.total > cap) {
      showToast(result)
    } else {
      dismissToast()
    }
  }, [expandAll, candidateIds, cap, showToast, dismissToast])

  const handleCollapse = useCallback(() => {
    collapseAll(candidateIds)
    dismissToast()
  }, [collapseAll, candidateIds, dismissToast])

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
          // Fixed-position toast pinned to the bottom-center of the viewport so
          // the long over-cap message does not wrap the toolbar. Auto-dismisses
          // after OVER_CAP_TOAST_DURATION_MS or on the next bulk action.
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-md text-xs shadow-lg bg-[var(--bg-surface)] text-[var(--text)] border border-[var(--border)] max-w-[90vw]"
        >
          {formatOverCapMessage(overCap.expanded, overCap.total)}
        </div>
      )}
    </>
  )
}
