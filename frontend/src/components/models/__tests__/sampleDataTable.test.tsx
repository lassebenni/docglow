/**
 * Unit tests for the pure helpers exported from SampleDataTable.
 *
 * Locks in the three behaviours the reviewer flagged as fragile if untested:
 *
 *   1. NULL-last sort regardless of caller's direction sign.
 *   2. Numeric-aware compare on strings that parse as numbers.
 *   3. Case-insensitive substring search and every-match highlight wrapping.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  cellMatches,
  compareCells,
  renderCell,
} from '../SampleDataTable'

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
})

describe('compareCells', () => {
  it('puts NULLs last under straight asc compare', () => {
    const rows = ['b', null, 'a', 'c', null]
    const sorted = [...rows].sort((a, b) => compareCells(a, b))
    expect(sorted).toEqual(['a', 'b', 'c', null, null])
  })

  it('returns the right sign for NULL vs value in either order', () => {
    // Direction flip happens in the SampleDataTable caller; compareCells
    // itself is asymmetric so a straight sort puts NULL after everything.
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
    // 'Konijnenland' has four 'n' characters — every one gets its own <mark>.
    const markCount = (html.match(/<mark /g) ?? []).length
    expect(markCount).toBe(4)
    expect(html).toContain('Ko')        // pre-first-match
    expect(html).toContain('la')        // between the last two 'n's
    expect(html).toMatch(/d$/)           // post-last-match trailing char
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
