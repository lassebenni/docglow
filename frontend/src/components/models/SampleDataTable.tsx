import { useMemo, useState, type ReactNode } from 'react'
import type { SampleData } from '../../types'
import {
  buildDisplayColumns,
  expandSampleRows,
  isWithheldCell,
  withheldColumnSet,
  WITHHELD_CELL_DISPLAY,
  type SampleCell,
} from './sampleDataDisplay'

type SortDirection = 'asc' | 'desc'
type SortState = { column: string; direction: SortDirection } | null

interface SampleDataTableProps {
  data: SampleData
}

/**
 * Interactive table for the pre-dumped warehouse sample.
 *
 * - Substring search filters rows across every column (case-insensitive).
 * - Withheld PII columns appear in warehouse order with a •••• placeholder;
 *   values are never sampled from the database.
 * - Click a column header to cycle tri-state asc → desc → none (withheld
 *   columns are not sortable).
 */
export function SampleDataTable({ data }: SampleDataTableProps) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>(null)

  const withheld = useMemo(() => withheldColumnSet(data), [data])
  const displayColumns = useMemo(() => buildDisplayColumns(data), [data])
  const displayRows = useMemo(
    () => expandSampleRows(data, displayColumns, withheld),
    [data, displayColumns, withheld],
  )

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return displayRows
    return displayRows.filter(row => row.some(cell => cellMatches(cell, q)))
  }, [displayRows, search])

  const originalIndex = useMemo(() => {
    const m = new Map<readonly SampleCell[], number>()
    displayRows.forEach((r, i) => m.set(r, i))
    return m
  }, [displayRows])

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows
    const idx = displayColumns.indexOf(sort.column)
    if (idx < 0) return filteredRows
    const direction = sort.direction === 'asc' ? 1 : -1
    return [...filteredRows].sort((a, b) => direction * compareCells(a[idx], b[idx]))
  }, [filteredRows, sort, displayColumns])

  function onHeaderClick(column: string) {
    if (withheld.has(column)) return
    setSort(prev => {
      if (!prev || prev.column !== column) return { column, direction: 'asc' }
      if (prev.direction === 'asc') return { column, direction: 'desc' }
      return null
    })
  }

  const lowerQuery = search.trim().toLowerCase()
  const withheldCount = withheld.size
  const withheldTitle = withheldCount
    ? [
        ...[...withheld].map(c =>
          data.excluded_columns?.pii_meta?.includes(c)
            ? `${c} (meta.pii=true)`
            : `${c} (name-flagged)`,
        ),
      ].join('\n')
    : ''

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
        {withheldCount > 0 && (
          <span
            className="px-1.5 py-0.5 rounded bg-warning/10 text-warning border border-warning/30
                       text-[11px] cursor-help"
            title={withheldTitle}
          >
            {withheldCount} PII column{withheldCount === 1 ? '' : 's'} shown as {WITHHELD_CELL_DISPLAY}
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded border border-[var(--border)] max-h-[60vh] overflow-y-auto">
        <table className="text-xs w-max">
          <thead>
            <tr>
              {displayColumns.map(col => {
                const isWithheld = withheld.has(col)
                const active = !isWithheld && sort?.column === col
                const indicator = isWithheld
                  ? 'PII'
                  : !active
                    ? '⇅'
                    : sort!.direction === 'asc'
                      ? '▲'
                      : '▼'
                return (
                  <th
                    key={col}
                    className={`sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border)]
                               px-3 py-2 text-left font-medium whitespace-nowrap
                               ${isWithheld ? 'text-warning/90' : ''}`}
                  >
                    {isWithheld ? (
                      <span
                        className="inline-flex items-center gap-1"
                        title="PII — values withheld from sample"
                      >
                        <span>{col}</span>
                        <span className="text-[var(--text-muted)] text-[10px]">{indicator}</span>
                      </span>
                    ) : (
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
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={displayColumns.length}
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
                      className={`px-3 py-1.5 whitespace-nowrap max-w-[24rem] truncate
                                 border-b border-[var(--border)]/50
                                 ${isWithheldCell(cell) ? 'text-warning/80 italic' : ''}`}
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
export function cellMatches(cell: SampleCell, lowerQuery: string): boolean {
  if (isWithheldCell(cell)) return false
  if (cell === null) return false
  return String(cell).toLowerCase().includes(lowerQuery)
}

function cellToTitle(cell: SampleCell): string {
  if (isWithheldCell(cell)) return 'PII — value withheld from sample'
  if (cell === null) return 'NULL'
  return String(cell)
}

export function renderCell(cell: SampleCell, lowerQuery: string): ReactNode {
  if (isWithheldCell(cell)) {
    return (
      <span className="tracking-widest select-none" aria-label="PII withheld">
        {WITHHELD_CELL_DISPLAY}
      </span>
    )
  }
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

export function compareCells(a: SampleCell, b: SampleCell): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  const aNum = toFiniteNumber(a)
  const bNum = toFiniteNumber(b)
  if (aNum !== null && bNum !== null) return aNum - bNum

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

function toFiniteNumber(cell: Exclude<SampleCell, null>): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'boolean') return null
  const trimmed = String(cell).trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}
