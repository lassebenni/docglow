/**
 * Unit tests for sample data display helpers and SampleDataTable pure functions.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SampleData } from '../../../types'
import {
  buildDisplayColumns,
  expandSampleRows,
  isWithheldCell,
  withheldColumnSet,
  WITHHELD_CELL_DISPLAY,
} from '../sampleDataDisplay'
import {
  cellMatches,
  compareCells,
  renderCell,
} from '../SampleDataTable'

function sampleData(overrides: Partial<SampleData> = {}): SampleData {
  return {
    schema: 'dbt_prod_exports',
    table: 'exp_buyer',
    columns: ['buyer_code', 'target_areas'],
    rows: [
      ['B01', 'D-A'],
      ['B02', null],
    ],
    row_count: 2,
    limit: 25,
    generated_at: '2026-06-25T12:00:00Z',
    all_columns: ['buyer_code', 'buyer_name', 'target_areas'],
    excluded_columns: {
      pii_meta: ['buyer_name'],
      name_flagged: [],
    },
    ...overrides,
  }
}

describe('buildDisplayColumns', () => {
  it('uses all_columns when present', () => {
    expect(buildDisplayColumns(sampleData())).toEqual([
      'buyer_code',
      'buyer_name',
      'target_areas',
    ])
  })

  it('appends withheld columns when all_columns is absent', () => {
    const data = sampleData({ all_columns: undefined })
    expect(buildDisplayColumns(data)).toEqual(['buyer_code', 'target_areas', 'buyer_name'])
  })
})

describe('expandSampleRows', () => {
  it('inserts withheld placeholder in warehouse order', () => {
    const data = sampleData()
    const cols = buildDisplayColumns(data)
    const withheld = withheldColumnSet(data)
    const rows = expandSampleRows(data, cols, withheld)
    expect(rows[0]).toEqual(['B01', WITHHELD_CELL_DISPLAY, 'D-A'])
    expect(rows[1]).toEqual(['B02', WITHHELD_CELL_DISPLAY, null])
  })
})

describe('cellMatches', () => {
  it('matches case-insensitive substrings', () => {
    expect(cellMatches('KINDEREN', 'kinde')).toBe(true)
    expect(cellMatches('child', 'kinde')).toBe(false)
  })

  it('coerces numbers and booleans before searching', () => {
    expect(cellMatches(12345, '234')).toBe(true)
    expect(cellMatches(true, 'rue')).toBe(true)
  })

  it('returns false when the query is nowhere in the cell', () => {
    expect(cellMatches('foo', 'bar')).toBe(false)
  })

  it('never matches on NULL', () => {
    expect(cellMatches(null, '')).toBe(false)
    expect(cellMatches(null, 'null')).toBe(false)
  })

  it('never matches withheld placeholder cells', () => {
    expect(cellMatches(WITHHELD_CELL_DISPLAY, '••')).toBe(false)
    expect(isWithheldCell(WITHHELD_CELL_DISPLAY)).toBe(true)
  })
})

describe('compareCells', () => {
  it('puts NULLs last under straight asc compare', () => {
    const rows = ['b', null, 'a', 'c', null]
    const sorted = [...rows].sort((a, b) => compareCells(a, b))
    expect(sorted).toEqual(['a', 'b', 'c', null, null])
  })

  it('returns the right sign for NULL vs value in either order', () => {
    expect(compareCells(null, 'a')).toBeGreaterThan(0)
    expect(compareCells('a', null)).toBeLessThan(0)
  })

  it('keeps NULL pairs equal so the sort is stable across them', () => {
    expect(compareCells(null, null)).toBe(0)
  })

  it('compares numerically when both cells parse as finite numbers', () => {
    expect(compareCells('2', '10')).toBeLessThan(0)
    expect(compareCells(10, 2)).toBeGreaterThan(0)
    expect(compareCells('  3.5 ', '3.49')).toBeGreaterThan(0)
  })

  it('falls back to locale compare with numeric collation for mixed strings', () => {
    expect(compareCells('item_2', 'item_10')).toBeLessThan(0)
    expect(compareCells('Alpha', 'beta')).toBeLessThan(0)
  })

  it('treats booleans as non-numeric — they sort lexically (false < true)', () => {
    expect(compareCells(true, false)).toBeGreaterThan(0)
  })
})

describe('renderCell', () => {
  it('renders withheld cells as a redacted token', () => {
    const html = renderToStaticMarkup(<>{renderCell(WITHHELD_CELL_DISPLAY, '')}</>)
    expect(html).toContain(WITHHELD_CELL_DISPLAY)
    expect(html).toContain('aria-label="PII withheld"')
    expect(html).not.toContain('<mark')
  })

  it('renders NULL as a muted ∅ sentinel and never wraps it', () => {
    const html = renderToStaticMarkup(<>{renderCell(null, 'null')}</>)
    expect(html).toContain('∅')
    expect(html).not.toContain('<mark')
  })

  it('returns the plain string when query is empty', () => {
    const html = renderToStaticMarkup(<>{renderCell('Kinderen', '')}</>)
    expect(html).toBe('Kinderen')
  })

  it('wraps every non-overlapping match in <mark> spans, preserving casing', () => {
    const html = renderToStaticMarkup(<>{renderCell('Konijnenland', 'n')}</>)
    const markCount = (html.match(/<mark /g) ?? []).length
    expect(markCount).toBe(4)
    expect(html).toContain('Ko')
    expect(html).toContain('la')
    expect(html).toMatch(/d$/)
  })

  it('matches case-insensitively but preserves source casing in the output', () => {
    const html = renderToStaticMarkup(<>{renderCell('KINDEREN', 'kinde')}</>)
    expect(html).toContain('>KINDE<')
    expect(html).toContain('REN')
  })

  it('coerces non-string cells before searching (booleans, numbers)', () => {
    const numHtml = renderToStaticMarkup(<>{renderCell(12345, '234')}</>)
    expect(numHtml).toContain('>234<')
    const boolHtml = renderToStaticMarkup(<>{renderCell(true, 'rue')}</>)
    expect(boolHtml).toContain('>rue<')
  })

  it('applies the muted-text class to the NULL sentinel span', () => {
    const html = renderToStaticMarkup(<>{renderCell(null, '')}</>)
    expect(html).toContain('text-[var(--text-muted)]')
  })

  it('does not highlight NULL even when the query is the ∅ sentinel itself', () => {
    const html = renderToStaticMarkup(<>{renderCell(null, '∅')}</>)
    expect(html).not.toContain('<mark')
  })
})
