import { describe, expect, it } from 'vitest'
import type { ColumnLineageData } from '../types'
import {
  buildReverseIndex,
  getFieldPathColumnTrace,
} from '../utils/columnLineageGraph'

const columnLineage: ColumnLineageData = {
  'exposure.x.dash': {
    Revenue: [
      {
        source_model: 'model.x.mart',
        source_column: 'amount',
        transformation: 'aggregated',
      },
    ],
  },
  'model.x.mart': {
    amount: [
      {
        source_model: 'model.x.stg',
        source_column: 'amount',
        transformation: 'passthrough',
      },
    ],
  },
  'model.x.child': {
    amount: [
      {
        source_model: 'model.x.mart',
        source_column: 'amount',
        transformation: 'passthrough',
      },
    ],
  },
}

describe('getFieldPathColumnTrace direction options', () => {
  const reverseIndex = buildReverseIndex(columnLineage)

  it('defaults to upstream-only (measure → mart → stg)', () => {
    const result = getFieldPathColumnTrace(
      'exposure.x.dash',
      'Revenue',
      columnLineage,
      reverseIndex,
    )
    const models = [...result.highlightedColumns.keys()].sort()
    expect(models).toEqual(['exposure.x.dash', 'model.x.mart', 'model.x.stg'])
  })

  it('includes downstream when includeDownstream is true', () => {
    const result = getFieldPathColumnTrace(
      'model.x.mart',
      'amount',
      columnLineage,
      reverseIndex,
      { includeUpstream: true, includeDownstream: true },
    )
    expect(result.highlightedColumns.has('model.x.stg')).toBe(true)
    expect(result.highlightedColumns.has('model.x.child')).toBe(true)
  })

  it('downstream-only skips upstream SQL', () => {
    const result = getFieldPathColumnTrace(
      'model.x.mart',
      'amount',
      columnLineage,
      reverseIndex,
      { includeUpstream: false, includeDownstream: true },
    )
    expect(result.highlightedColumns.has('model.x.stg')).toBe(false)
    expect(result.highlightedColumns.has('model.x.child')).toBe(true)
  })
})
