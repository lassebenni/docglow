import { describe, it, expect } from 'vitest'
import {
  ROW_H_COL,
  computeNodeHeight,
  computeColumnAnchorY,
} from '../utils/erdNodeDimensions'
import { ROW_H_HEAD } from '../utils/erdLayout'

describe('computeNodeHeight', () => {
  it('returns header-only height for compact regardless of column counts', () => {
    expect(computeNodeHeight('compact', 0, 0)).toBe(ROW_H_HEAD)
    expect(computeNodeHeight('compact', 5, 20)).toBe(ROW_H_HEAD)
  })

  it('uses keyCount in keys mode', () => {
    expect(computeNodeHeight('keys', 3, 10)).toBe(ROW_H_HEAD + 3 * ROW_H_COL)
  })

  it('uses totalCount in full mode', () => {
    expect(computeNodeHeight('full', 3, 10)).toBe(ROW_H_HEAD + 10 * ROW_H_COL)
  })
})

describe('computeColumnAnchorY', () => {
  it('returns header center for compact regardless of index', () => {
    expect(computeColumnAnchorY(100, 'compact', 0, 0)).toBe(100 + ROW_H_HEAD / 2)
    expect(computeColumnAnchorY(100, 'compact', 7, 0)).toBe(100 + ROW_H_HEAD / 2)
  })

  it('returns row-center for keys at index 2 with 3 rows rendered', () => {
    expect(computeColumnAnchorY(100, 'keys', 2, 3)).toBe(
      100 + ROW_H_HEAD + 2.5 * ROW_H_COL,
    )
  })

  it('returns row-center for full at index 2 with 10 rows rendered', () => {
    expect(computeColumnAnchorY(100, 'full', 2, 10)).toBe(
      100 + ROW_H_HEAD + 2.5 * ROW_H_COL,
    )
  })

  it('falls back to header center for out-of-range columnIndex', () => {
    expect(computeColumnAnchorY(100, 'keys', 5, 3)).toBe(100 + ROW_H_HEAD / 2)
    expect(computeColumnAnchorY(100, 'full', -1, 10)).toBe(100 + ROW_H_HEAD / 2)
  })
})
