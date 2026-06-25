import type { SampleData } from '../../types'

export type SampleCell = string | number | boolean | null

/** Display token for withheld PII cells — never sampled from the warehouse. */
export const WITHHELD_CELL_DISPLAY = '••••'

export function withheldColumnSet(data: SampleData): Set<string> {
  const pii = data.excluded_columns?.pii_meta ?? []
  const flagged = data.excluded_columns?.name_flagged ?? []
  return new Set([...pii, ...flagged])
}

/**
 * Column headers for the Data tab — full warehouse order when `all_columns`
 * is present, otherwise sampled columns plus withheld names appended.
 */
export function buildDisplayColumns(data: SampleData): string[] {
  if (data.all_columns?.length) {
    return [...data.all_columns]
  }

  const withheld = withheldColumnSet(data)
  const seen = new Set<string>()
  const out: string[] = []

  for (const col of data.columns) {
    if (!seen.has(col)) {
      out.push(col)
      seen.add(col)
    }
  }
  for (const col of withheld) {
    if (!seen.has(col)) {
      out.push(col)
      seen.add(col)
    }
  }
  return out
}

/** Expand sampled rows to align with `displayColumns`, redacting withheld cells. */
export function expandSampleRows(
  data: SampleData,
  displayColumns: string[],
  withheld: Set<string>,
): ReadonlyArray<ReadonlyArray<SampleCell>> {
  const safeIndex = new Map<string, number>(
    data.columns.map((c, i) => [c, i] as const),
  )

  return data.rows.map(row =>
    displayColumns.map(col => {
      if (withheld.has(col)) return WITHHELD_CELL_DISPLAY
      const idx = safeIndex.get(col)
      if (idx === undefined) return WITHHELD_CELL_DISPLAY
      return row[idx] as SampleCell
    }),
  )
}

export function isWithheldCell(cell: SampleCell): boolean {
  return cell === WITHHELD_CELL_DISPLAY
}
