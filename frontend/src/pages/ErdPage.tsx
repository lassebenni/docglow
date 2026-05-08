/**
 * ErdPage — focus-driven ERD explorer (U6 / DOC-222).
 *
 * Mirrors `LineagePage`'s dual-mode structure:
 *   - **Landing** (no `?focus=` param): heading + search + "Suggested
 *     starting points" grid ranked by `relationships_count` desc.
 *   - **Focused canvas** (`?focus=<uid>&depth=N`): top bar with back arrow
 *     + focus badge + depth slider + count summary, then `<ErdCanvas>` fed
 *     a pre-filtered subgraph reachable within `depth` hops from `focus`.
 *
 * URL state via `useSearchParams` — bookmarkable. Default depth: 2 (min 1,
 * max 4 — higher depths produce noisy subgraphs).
 *
 * Pre-U6 behavior was "render the entire ERD on `/erd`". That fell over on
 * 1000+ model projects (4000-edge cloud, visually useless). The focus
 * picker is the user-facing fix; the canvas itself is unchanged and stays
 * in `standalone` mode.
 */

import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ErdCanvas } from '../components/erd/ErdCanvas'
import { useProjectStore } from '../stores/projectStore'
import { computeErdSuggestions } from '../utils/erdSuggestions'
import { getReachableErdSubgraph } from '../utils/erdSubgraph'

const DEFAULT_DEPTH = 2
const MIN_DEPTH = 1
const MAX_DEPTH = 4

function clampDepth(raw: string | null): number {
  if (raw === null) return DEFAULT_DEPTH
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return DEFAULT_DEPTH
  return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, n))
}

export function ErdPage() {
  const { data } = useProjectStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')

  const focus = searchParams.get('focus') ?? ''
  const depth = clampDepth(searchParams.get('depth'))

  const setFocus = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams)
      next.set('focus', id)
      next.set('depth', String(DEFAULT_DEPTH))
      setSearchParams(next, { replace: true })
      setSearch('')
    },
    [searchParams, setSearchParams],
  )

  const clearFocus = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.delete('focus')
    next.delete('depth')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const setDepth = useCallback(
    (nextDepth: number) => {
      const clamped = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, nextDepth))
      const next = new URLSearchParams(searchParams)
      next.set('depth', String(clamped))
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const allRelationships = useMemo(() => data?.relationships ?? [], [data])

  const suggestions = useMemo(() => {
    if (!data) return []
    return computeErdSuggestions(data.models)
  }, [data])

  const searchResults = useMemo(() => {
    if (!data || !search) return []
    const q = search.toLowerCase()
    return Object.entries(data.models)
      .filter(
        ([, m]) =>
          m.name.toLowerCase().includes(q) ||
          m.folder.toLowerCase().includes(q),
      )
      .slice(0, 20)
      .map(([uniqueId, m]) => ({
        uniqueId,
        name: m.name,
        folder: m.folder,
        relationshipsCount: m.relationships_count ?? 0,
      }))
  }, [data, search])

  const totalRelationships = allRelationships.length
  const totalModels = data ? Object.keys(data.models).length : 0

  // Pre-filter inputs for `ErdCanvas` when a focus is set. Computed
  // unconditionally (cheap pure function) but only consumed in focused mode.
  const focusedSubgraph = useMemo(() => {
    if (!focus) return null
    return getReachableErdSubgraph(focus, allRelationships, depth)
  }, [focus, allRelationships, depth])

  const focusedModels = useMemo(() => {
    if (!data || !focusedSubgraph) return null
    const out: Record<string, (typeof data.models)[string]> = {}
    for (const uid of focusedSubgraph.models) {
      const m = data.models[uid]
      if (m) out[uid] = m
    }
    return out
  }, [data, focusedSubgraph])

  if (!data) return null

  // Focused canvas branch
  if (focus) {
    const focusModel = data.models[focus]

    // Edge case: stale URL — focus references a model that doesn't exist
    // in `data.models`. Render a small inline error rather than throwing.
    if (!focusModel) {
      return (
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto py-8 px-4">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
                <div className="text-sm font-medium text-[var(--text)]">
                  Model not found:{' '}
                  <code className="font-mono text-xs">{focus}</code>
                </div>
                <button
                  type="button"
                  onClick={clearFocus}
                  className="mt-2 text-xs text-primary hover:underline cursor-pointer"
                >
                  Back to ERD landing
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    }

    const subgraphRelCount = focusedSubgraph?.relationships.length ?? 0
    const subgraphModelCount = focusedSubgraph?.models.size ?? 0

    return (
      <div className="h-full flex flex-col">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border)] shrink-0 flex-wrap">
          <button
            type="button"
            onClick={clearFocus}
            className="p-1 rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors text-[var(--text-muted)] shrink-0"
            title="Back to ERD landing"
            aria-label="Back to ERD landing"
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
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-primary/10 text-primary text-xs font-medium">
            <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">
              Focus
            </span>
            <span>{focusModel.name}</span>
            <button
              type="button"
              onClick={clearFocus}
              className="text-primary hover:text-[var(--text)] cursor-pointer ml-0.5"
              title="Clear focus"
              aria-label="Clear focus"
            >
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-muted)]">Depth</label>
            <input
              type="range"
              min={MIN_DEPTH}
              max={MAX_DEPTH}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="w-20 accent-[var(--primary)]"
              aria-label="Focus depth"
            />
            <span className="text-xs font-medium w-4 text-center">{depth}</span>
          </div>

          <span className="text-xs text-[var(--text-muted)] ml-auto">
            {subgraphModelCount} tables &middot; {subgraphRelCount} relationships
          </span>
        </div>

        {/* Body */}
        {focusedSubgraph && focusedSubgraph.relationships.length === 0 ? (
          // Focused model has zero relationships — show the focal model alone
          // (visual confirmation that focus worked) plus an inline message.
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-3 py-2 text-xs text-[var(--text-muted)] border-b border-[var(--border)] bg-[var(--bg-surface)]">
              This model has no declared relationships. Focus is set on{' '}
              <span className="font-medium text-[var(--text)]">
                {focusModel.name}
              </span>
              .
            </div>
            <div className="flex-1 min-h-0">
              <ErdCanvas
                mode="standalone"
                models={focusedModels ?? { [focus]: focusModel }}
                relationships={[]}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <ErdCanvas
              mode="standalone"
              models={focusedModels ?? data.models}
              relationships={focusedSubgraph?.relationships ?? []}
            />
          </div>
        )}
      </div>
    )
  }

  // Landing screen
  const showSearchResults = search.length > 0

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-8 px-4">
          <h1 className="text-2xl font-bold mb-1">ERD Explorer</h1>
          <p className="text-sm text-[var(--text-muted)] mb-6">
            Search for a model to focus the ERD on its joins.
          </p>

          {/* Search */}
          <div className="relative mb-8">
            <div className="flex items-center gap-2 px-3 py-2.5 border border-[var(--border)] rounded-lg bg-[var(--bg)] focus-within:border-primary transition-colors">
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-muted, #64748b)"
                strokeWidth={2}
              >
                <circle cx={11} cy={11} r={8} />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search for a model..."
                className="flex-1 bg-transparent outline-none text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                  aria-label="Clear search"
                >
                  <svg
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {showSearchResults && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[var(--bg)] border border-[var(--border)] rounded-lg shadow-lg max-h-64 overflow-y-auto">
                {searchResults.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    No models found
                  </div>
                ) : (
                  searchResults.map((r) => (
                    <button
                      key={r.uniqueId}
                      type="button"
                      onClick={() => setFocus(r.uniqueId)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-[var(--bg-surface)] cursor-pointer transition-colors flex items-center justify-between"
                    >
                      <div>
                        <div className="font-medium text-[var(--text)]">
                          {r.name}
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">
                          {r.folder}
                        </div>
                      </div>
                      <span className="text-xs text-[var(--text-muted)] shrink-0 ml-2">
                        {r.relationshipsCount} rel
                        {r.relationshipsCount === 1 ? '' : 's'}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Suggestions */}
          {!showSearchResults && (
            <>
              <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
                Suggested starting points
              </h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Models with the most declared relationships in your project —
                good places to start exploring.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {suggestions.map((s) => (
                  <button
                    key={s.uniqueId}
                    type="button"
                    onClick={() => setFocus(s.uniqueId)}
                    className="text-left p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] hover:border-primary/50 cursor-pointer transition-colors group"
                  >
                    <div className="font-medium text-sm text-[var(--text)] group-hover:text-primary transition-colors truncate">
                      {s.name}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                      {s.folder}
                    </div>
                    <div className="flex gap-3 mt-2 text-xs text-[var(--text-muted)]">
                      <span className="flex items-center gap-1">
                        <svg
                          width={10}
                          height={10}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path d="M5 12h14M8 8l-4 4 4 4M16 8l4 4-4 4" />
                        </svg>
                        {s.relationshipsCount} relationship
                        {s.relationshipsCount === 1 ? '' : 's'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-6 text-xs text-[var(--text-muted)]">
                {totalModels} models &middot; {totalRelationships} relationships
                in this project
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
