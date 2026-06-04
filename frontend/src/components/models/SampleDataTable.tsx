import { useMemo, useState, type ReactNode } from 'react'
import type { SampleData } from '../../types'

type SortDirection = 'asc' | 'desc'
type SortState = { column: string; direction: SortDirection } | null
type Cell = string | number | boolean | null

interface SampleDataTableProps {
  data: SampleData
}

/**
 * Interactive table for the pre-dumped warehouse sample.
 *
 * - Substring search filters rows across every column (case-insensitive).
 * - Click a column header to cycle tri-state asc → desc → none.  Numeric
 *   columns are compared numerically when both sides parse as finite numbers;
 *   otherwise `localeCompare` is used.
 * - The whole table sits in an `overflow-x-auto` wrapper so wide payloads
 *   scroll inside the tab rather than pushing the page sideways.
 */
export function SampleDataTable({ data }: SampleDataTableProps) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>(null)

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return data.rows
    return data.rows.filter(row => row.some(cell => cellMatches(cell, q)))
  }, [data.rows, search])

  // Stable per-row keys for React reconciliation: map each row tuple to its
  // original index in `data.rows`.  Without this, sort/filter changes recycle
  // <tr> DOM nodes by display position, which is fine for plain cells but
  // breaks if a row ever gains internal state (focus, expanded details, …).
  const originalIndex = useMemo(() => {
    const m = new Map<readonly Cell[], number>()
    data.rows.forEach((r, i) => m.set(r, i))
    return m
  }, [data.rows])

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows
    const idx = data.columns.indexOf(sort.column)
    if (idx < 0) return filteredRows
    const direction = sort.direction === 'asc' ? 1 : -1
    // Slice to avoid mutating the upstream (frozen) rows array.
    return [...filteredRows].sort((a, b) => direction * compareCells(a[idx], b[idx]))
  }, [filteredRows, sort, data.columns])

  function onHeaderClick(column: string) {
    setSort(prev => {
      if (!prev || prev.column !== column) return { column, direction: 'asc' }
      if (prev.direction === 'asc') return { column, direction: 'desc' }
      return null
    })
  }

  const lowerQuery = search.trim().toLowerCase()
  const excludedPii = data.excluded_columns?.pii_meta ?? []
  const excludedNameFlagged = data.excluded_columns?.name_flagged ?? []
  const excludedTotal = excludedPii.length + excludedNameFlagged.length
  const excludedTitle = [
    excludedPii.length ? `Tagged meta.pii=true: ${excludedPii.join(', ')}` : '',
    excludedNameFlagged.length ? `Name-flagged: ${excludedNameFlagged.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="flex flex-col gap-2" data-testid="model-data-tab">
      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search rows…"
          className="px-2 py-1 text-xs border border-[var(--border)] rounded
                     bg-[var(--bg)] outline-none focus:border-primary w-56"
        />
        <span>
          Showing <span className="font-medium text-[var(--text)]">{sortedRows.length}</span>
          {' of '}
          <span className="font-medium text-[var(--text)]">{data.row_count}</span>
          {' rows'}
          {data.row_count >= data.limit ? ` (limit ${data.limit})` : ''}
          {' — sampled from '}
          <code className="text-[var(--text)]">{data.schema}.{data.table}</code>
        </span>
        {excludedTotal > 0 && (
          <span
            className="px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/30
                       text-[11px] cursor-help"
            title={excludedTitle}
          >
            {excludedTotal} column{excludedTotal === 1 ? '' : 's'} withheld (PII)
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded border border-[var(--border)] max-h-[60vh] overflow-y-auto">
        <table className="text-xs w-max">
          <thead>
            <tr>
              {data.columns.map(col => {
                const active = sort?.column === col
                const indicator = !active ? '⇅' : sort!.direction === 'asc' ? '▲' : '▼'
                return (
                  <th
                    key={col}
                    className="sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border)]
                               px-3 py-2 text-left font-medium whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => onHeaderClick(col)}
                      className={`inline-flex items-center gap-1 cursor-pointer
                                  ${active ? 'text-primary' : 'text-[var(--text)]'}
                                  hover:text-primary`}
                    >
                      <span>{col}</span>
                      <span className="text-[var(--text-muted)] text-[10px]">{indicator}</span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={data.columns.length}
                  className="px-3 py-6 text-center text-[var(--text-muted)]"
                >
                  No rows match.
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => (
                <tr
                  key={originalIndex.get(row) ?? i}
                  className="even:bg-[var(--bg-surface)]/40"
                >
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="px-3 py-1.5 whitespace-nowrap max-w-[24rem] truncate
                                 border-b border-[var(--border)]/50"
                      title={cellToTitle(cell)}
                    >
                      {renderCell(cell, lowerQuery)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** True iff `lowerQuery` is a case-insensitive substring of String(cell). NULL never matches. */
export function cellMatches(cell: Cell, lowerQuery: string): boolean {
  if (cell === null) return false
  return String(cell).toLowerCase().includes(lowerQuery)
}

function cellToTitle(cell: Cell): string {
  if (cell === null) return 'NULL'
  return String(cell)
}

/**
 * Render a cell with the search query highlighted in every matched position.
 *
 * - NULL renders as a muted "∅" sentinel (and is never highlighted).
 * - The query is matched case-insensitively against the cell's String() form;
 *   matches in the original casing are preserved in the output.
 * - Multiple non-overlapping matches per cell are all highlighted (e.g.
 *   "Konijnenland" matched by "n" highlights every "n").
 */
export function renderCell(cell: Cell, lowerQuery: string): ReactNode {
  if (cell === null) {
    return <span className="text-[var(--text-muted)]">∅</span>
  }
  const text = typeof cell === 'boolean' ? (cell ? 'true' : 'false') : String(cell)
  if (!lowerQuery) return text

  const lowerText = text.toLowerCase()
  const qLen = lowerQuery.length
  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  let hit = lowerText.indexOf(lowerQuery)
  while (hit !== -1) {
    if (hit > cursor) parts.push(text.slice(cursor, hit))
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-primary/25 text-[var(--text)] px-0.5"
      >
        {text.slice(hit, hit + qLen)}
      </mark>,
    )
    cursor = hit + qLen
    hit = lowerText.indexOf(lowerQuery, cursor)
  }
  if (cursor === 0) return text
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

export function compareCells(a: Cell, b: Cell): number {
  // NULLs sort last regardless of direction sign — direction flip in the
  // caller already handles asc/desc; we still want NULL out of the way.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  const aNum = toFiniteNumber(a)
  const bNum = toFiniteNumber(b)
  if (aNum !== null && bNum !== null) return aNum - bNum

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

function toFiniteNumber(cell: Exclude<Cell, null>): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'boolean') return null
  const trimmed = cell.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}
