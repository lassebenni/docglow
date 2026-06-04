import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  cellMatches,
  compareCells,
  renderCell,
} from '../components/models/SampleDataTable'

describe('cellMatches', () => {
  it('matches case-insensitively against String(cell)', () => {
    expect(cellMatches('Kinderen', 'kinde')).toBe(true)
    expect(cellMatches('KINDEREN', 'kinde')).toBe(true)
  })

  it('matches numbers via String() coercion', () => {
    expect(cellMatches(1234, '23')).toBe(true)
    expect(cellMatches(0, '0')).toBe(true)
  })

  it('matches booleans via String() coercion', () => {
    expect(cellMatches(true, 'true')).toBe(true)
    expect(cellMatches(false, 'fal')).toBe(true)
  })

  it('never matches NULL', () => {
    expect(cellMatches(null, '')).toBe(false)
    expect(cellMatches(null, 'null')).toBe(false)
  })

  it('returns false for non-substring queries', () => {
    expect(cellMatches('foo', 'bar')).toBe(false)
  })
})

describe('compareCells', () => {
  it('sorts NULLs last regardless of direction', () => {
    // Asc semantics in the caller flip the sign; here we just assert NULL > value.
    expect(compareCells(null, 'a')).toBeGreaterThan(0)
    expect(compareCells('a', null)).toBeLessThan(0)
    expect(compareCells(null, null)).toBe(0)
  })

  it('compares numerically when both sides parse as finite numbers', () => {
    expect(compareCells(10, 2)).toBeGreaterThan(0)
    expect(compareCells('10', '2')).toBeGreaterThan(0) // string ordering would say '10' < '2'
    expect(compareCells(2, 10)).toBeLessThan(0)
  })

  it('falls back to locale numeric-aware compare for mixed strings', () => {
    expect(compareCells('item_2', 'item_10')).toBeLessThan(0) // numeric collation
    expect(compareCells('apple', 'banana')).toBeLessThan(0)
  })

  it('treats boolean as non-numeric (string compare)', () => {
    // true and false aren't compared numerically — they sort lexically.
    expect(compareCells(true, false)).toBeGreaterThan(0)
  })
})

describe('renderCell', () => {
  function renderToString(node: ReturnType<typeof renderCell>): string {
    return renderToStaticMarkup(<>{node}</>)
  }

  it('renders NULL as a muted ∅ sentinel', () => {
    const html = renderToString(renderCell(null, ''))
    expect(html).toContain('∅')
    expect(html).toContain('text-[var(--text-muted)]')
  })

  it('returns plain text when query is empty', () => {
    const html = renderToString(renderCell('Hello', ''))
    expect(html).toBe('Hello')
    expect(html).not.toContain('<mark')
  })

  it('wraps a single match in <mark>', () => {
    const html = renderToString(renderCell('Kinderen', 'kinde'))
    expect(html).toContain('<mark')
    expect(html).toMatch(/<mark[^>]*>Kinde<\/mark>ren/)
  })

  it('highlights every non-overlapping match in the cell', () => {
    const html = renderToString(renderCell('banana', 'na'))
    // 'banana' contains 'na' twice (positions 2 and 4).
    expect((html.match(/<mark/g) ?? []).length).toBe(2)
  })

  it('preserves original casing in the highlighted span', () => {
    const html = renderToString(renderCell('KINDEREN', 'kinde'))
    expect(html).toMatch(/<mark[^>]*>KINDE<\/mark>REN/)
  })

  it('stringifies booleans and highlights them', () => {
    const html = renderToString(renderCell(true, 'tru'))
    expect(html).toMatch(/<mark[^>]*>tru<\/mark>e/)
  })

  it('does not highlight NULL even when query matches its sentinel', () => {
    const html = renderToString(renderCell(null, '∅'))
    expect(html).not.toContain('<mark')
  })
})
