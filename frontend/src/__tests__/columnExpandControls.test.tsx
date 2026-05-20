import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXPAND_ALL_CAP,
  OVER_CAP_DETAIL_TEXT,
  collapseTooltip,
  expandTooltip,
  formatOverCapHeadline,
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
  it('disables when there are no candidates', () => {
    expect(shouldDisableCollapseAll(0)).toBe(true)
  })

  it('enables when at least one candidate exists (covers AE2)', () => {
    // The local auto-expand memo in LineageFlow may have rendered columns even
    // when no store-tracked expansion has happened, so Collapse all must remain
    // available whenever candidates exist.
    expect(shouldDisableCollapseAll(10)).toBe(false)
    expect(shouldDisableCollapseAll(1)).toBe(false)
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
  it('returns the nothing-to-collapse tooltip when there are no candidates', () => {
    expect(collapseTooltip(0)).toBe('Nothing to collapse')
  })

  it('returns undefined when candidates exist (no tooltip needed)', () => {
    expect(collapseTooltip(5)).toBeUndefined()
  })
})

describe('formatOverCapHeadline', () => {
  it('renders the headline format (covers AE1)', () => {
    expect(formatOverCapHeadline(50, 180)).toBe('Expanded 50 of 180')
  })

  it('renders with the default cap value', () => {
    expect(formatOverCapHeadline(DEFAULT_EXPAND_ALL_CAP, 100)).toBe('Expanded 50 of 100')
  })
})

describe('OVER_CAP_DETAIL_TEXT', () => {
  it('is the static guidance line shown below the headline', () => {
    expect(OVER_CAP_DETAIL_TEXT).toBe(
      'Narrow the graph with filters or pinning to see more.',
    )
  })
})

describe('DEFAULT_EXPAND_ALL_CAP', () => {
  it('is 50 as specified in the requirements', () => {
    expect(DEFAULT_EXPAND_ALL_CAP).toBe(50)
  })
})
