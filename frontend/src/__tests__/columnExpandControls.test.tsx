import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXPAND_ALL_CAP,
  collapseTooltip,
  expandTooltip,
  formatOverCapMessage,
  shouldDisableCollapseAll,
  shouldDisableExpandAll,
} from '../components/lineage/ColumnExpandControls'

/* No @testing-library/react in this repo and vitest runs in `node` env, so
   we exercise the controls via their pure helpers — same pattern as
   erdInspector.test.tsx. The render branches themselves are thin switches
   over these helpers and the store. */

describe('shouldDisableExpandAll', () => {
  it('disables when there are no candidate ids', () => {
    expect(shouldDisableExpandAll(0)).toBe(true)
  })

  it('enables when at least one candidate exists', () => {
    expect(shouldDisableExpandAll(1)).toBe(false)
    expect(shouldDisableExpandAll(217)).toBe(false)
  })
})

describe('shouldDisableCollapseAll', () => {
  it('disables when both expanded and auto-expanded sets are empty', () => {
    expect(shouldDisableCollapseAll(0, 0)).toBe(true)
  })

  it('enables when something is manually expanded', () => {
    expect(shouldDisableCollapseAll(3, 0)).toBe(false)
  })

  it('enables when something is auto-expanded (covers AE2)', () => {
    // 10-node graph that auto-expanded all → user must be able to collapse them
    expect(shouldDisableCollapseAll(0, 10)).toBe(false)
  })
})

describe('expandTooltip', () => {
  it('returns the no-data tooltip when there are zero candidates (covers AE4)', () => {
    expect(expandTooltip(0)).toBe('No column lineage data in this graph')
  })

  it('returns undefined when candidates exist (no tooltip needed)', () => {
    expect(expandTooltip(5)).toBeUndefined()
  })
})

describe('collapseTooltip', () => {
  it('returns the nothing-to-collapse tooltip when nothing is expanded', () => {
    expect(collapseTooltip(0, 0)).toBe('Nothing to collapse')
  })

  it('returns undefined when at least one node is expanded', () => {
    expect(collapseTooltip(1, 0)).toBeUndefined()
    expect(collapseTooltip(0, 1)).toBeUndefined()
  })
})

describe('formatOverCapMessage', () => {
  it('renders the exact over-cap text format (covers AE1)', () => {
    expect(formatOverCapMessage(50, 180)).toBe(
      'Expanded 50 of 180 — narrow the graph with filters or pinning to see more.',
    )
  })

  it('renders correctly with the default cap value', () => {
    expect(formatOverCapMessage(DEFAULT_EXPAND_ALL_CAP, 100)).toBe(
      'Expanded 50 of 100 — narrow the graph with filters or pinning to see more.',
    )
  })
})

describe('DEFAULT_EXPAND_ALL_CAP', () => {
  it('is 50 as specified in the requirements', () => {
    expect(DEFAULT_EXPAND_ALL_CAP).toBe(50)
  })
})
