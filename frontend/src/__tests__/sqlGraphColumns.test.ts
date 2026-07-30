import { describe, expect, it } from 'vitest'
import { collectColumnPath, colKey } from '../utils/sqlGraphColumns'
import type { SqlGraphColumnLineage } from '../types'

const lineage: SqlGraphColumnLineage = {
  'cte:supplies': {
    supply_cost: [
      {
        source_node: 'parent:stg_supplies',
        source_column: 'supply_cost',
        transformation: 'passthrough',
      },
    ],
  },
  'cte:order_supplies_summary': {
    supply_cost: [
      {
        source_node: 'cte:supplies',
        source_column: 'supply_cost',
        transformation: 'aggregated',
      },
    ],
    product_id: [
      {
        source_node: 'cte:supplies',
        source_column: 'product_id',
        transformation: 'passthrough',
      },
    ],
  },
  'cte:joined': {
    supply_cost: [
      {
        source_node: 'cte:order_supplies_summary',
        source_column: 'supply_cost',
        transformation: 'passthrough',
      },
    ],
  },
  'output:order_items': {
    supply_cost: [
      {
        source_node: 'cte:joined',
        source_column: 'supply_cost',
        transformation: 'passthrough',
      },
    ],
  },
}

describe('collectColumnPath', () => {
  it('traces supply_cost from joined upstream through aggregate', () => {
    const path = collectColumnPath(lineage, 'cte:joined', 'supply_cost')
    expect(path.keys.has(colKey('parent:stg_supplies', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('cte:order_supplies_summary', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('output:order_items', 'supply_cost'))).toBe(true)
    expect(path.edgeKeys.has('cte:supplies\0cte:order_supplies_summary')).toBe(true)

    const labels = path.steps.map(s => `${s.nodeId}:${s.column}`)
    expect(labels[0]).toBe('parent:stg_supplies:supply_cost')
    expect(labels.at(-1)).toMatch(/supply_cost$/)
    expect(path.steps.some(s => s.transformation === 'aggregated')).toBe(true)
  })

  it('returns focus only when lineage missing', () => {
    const path = collectColumnPath(undefined, 'cte:x', 'a')
    expect([...path.keys]).toEqual([colKey('cte:x', 'a')])
    expect(path.steps).toEqual([{ nodeId: 'cte:x', column: 'a' }])
  })
})
