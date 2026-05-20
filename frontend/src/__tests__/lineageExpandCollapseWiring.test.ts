import { describe, it, expect } from 'vitest'
import { getColumnLineageCandidateIds } from '../utils/columnLineageGraph'
import type { ColumnLineageData } from '../types'

/* Light wiring test (U3). Without @testing-library, we exercise the
   pure helper that both LineagePage and ModelPage call to build the
   candidateIds prop. */

describe('getColumnLineageCandidateIds', () => {
  it('returns nodes that are keys in column_lineage', () => {
    const columnLineage: ColumnLineageData = {
      'model.foo.a': { col_x: [] },
      'model.foo.b': { col_y: [] },
    }
    const nodes = [
      { id: 'model.foo.a' },
      { id: 'model.foo.b' },
      { id: 'model.foo.c' }, // no column lineage data, not a source either
    ]

    expect(getColumnLineageCandidateIds(nodes, columnLineage)).toEqual([
      'model.foo.a',
      'model.foo.b',
    ])
  })

  it('also includes source nodes referenced via source_model (R4)', () => {
    const columnLineage: ColumnLineageData = {
      'model.foo.stg_orders': {
        order_id: [
          { source_model: 'source.foo.raw.orders', source_column: 'id' },
        ],
      },
    }
    const nodes = [
      { id: 'model.foo.stg_orders' },
      { id: 'source.foo.raw.orders' }, // appears only as a source — must still be a candidate
    ]

    expect(getColumnLineageCandidateIds(nodes, columnLineage)).toEqual([
      'model.foo.stg_orders',
      'source.foo.raw.orders',
    ])
  })

  it('sorts candidate ids ascending (deterministic for cap behavior)', () => {
    const columnLineage: ColumnLineageData = {
      'model.foo.zeta': { c: [] },
      'model.foo.alpha': { c: [] },
      'model.foo.mu': { c: [] },
    }
    const nodes = [
      { id: 'model.foo.zeta' },
      { id: 'model.foo.alpha' },
      { id: 'model.foo.mu' },
    ]

    expect(getColumnLineageCandidateIds(nodes, columnLineage)).toEqual([
      'model.foo.alpha',
      'model.foo.mu',
      'model.foo.zeta',
    ])
  })

  it('returns empty list when column_lineage is null (AE4)', () => {
    const nodes = [{ id: 'model.foo.a' }, { id: 'model.foo.b' }]
    expect(getColumnLineageCandidateIds(nodes, null)).toEqual([])
    expect(getColumnLineageCandidateIds(nodes, undefined)).toEqual([])
  })

  it('returns empty list when subgraph has no nodes', () => {
    const columnLineage: ColumnLineageData = { 'model.foo.a': { c: [] } }
    expect(getColumnLineageCandidateIds([], columnLineage)).toEqual([])
  })

  it('omits nodes that have no column lineage and are not source references', () => {
    const columnLineage: ColumnLineageData = {
      'model.foo.a': {
        c: [{ source_model: 'source.foo.raw.x', source_column: 'id' }],
      },
    }
    const nodes = [
      { id: 'model.foo.a' },
      { id: 'source.foo.raw.x' },
      { id: 'model.foo.unrelated' }, // no entry, no source ref → excluded
    ]

    const ids = getColumnLineageCandidateIds(nodes, columnLineage)
    expect(ids).toContain('model.foo.a')
    expect(ids).toContain('source.foo.raw.x')
    expect(ids).not.toContain('model.foo.unrelated')
  })
})
