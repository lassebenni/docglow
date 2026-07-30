import { describe, it, expect } from 'vitest'
import {
  DEFAULT_EXPAND_ALL_CAP,
  OVER_CAP_DETAIL_TEXT,
  columnsModeTooltip,
  ctesModeTooltip,
  formatOverCapHeadline,
  shouldDisableColumnMode,
  shouldDisableCtesMode,
  tableModeTooltip,
} from '../components/lineage/ColumnExpandControls'

/* No @testing-library/react in this repo and vitest runs in `node` env, so
   we exercise the controls via their pure helpers — same pattern as
   erdInspector.test.tsx. The render branches themselves are thin switches
   over these helpers and the store. */

describe('shouldDisableColumnMode', () => {
  it('disables Columns mode when there are no candidate ids', () => {
    expect(shouldDisableColumnMode(0)).toBe(true)
  })

  it('enables Columns mode when at least one candidate exists', () => {
    expect(shouldDisableColumnMode(1)).toBe(false)
    expect(shouldDisableColumnMode(217)).toBe(false)
  })
})

describe('columnsModeTooltip', () => {
  it('returns the no-data tooltip when there are zero candidates', () => {
    expect(columnsModeTooltip(0)).toBe('No column lineage data in this graph')
  })

  it('returns the show-columns tooltip when candidates exist', () => {
    expect(columnsModeTooltip(5)).toBe('Show columns on nodes')
  })
})

describe('tableModeTooltip', () => {
  it('explains table-level collapse', () => {
    expect(tableModeTooltip()).toBe('Collapse to table-level lineage')
  })
})

describe('ctesModeTooltip', () => {
  it('explains CTE mode when a graph exists', () => {
    expect(ctesModeTooltip(true)).toBe('Show CTE / SQL graph for this model')
  })

  it('explains missing graph', () => {
    expect(ctesModeTooltip(false)).toBe('No CTE / SQL graph for this model')
  })
})

describe('shouldDisableCtesMode', () => {
  it('disables when no sql graph', () => {
    expect(shouldDisableCtesMode(false)).toBe(true)
    expect(shouldDisableCtesMode(true)).toBe(false)
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
