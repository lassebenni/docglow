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
  it('traces supply_cost upstream through aggregate (not downstream)', () => {
    const path = collectColumnPath(lineage, 'cte:joined', 'supply_cost')
    expect(path.keys.has(colKey('parent:stg_supplies', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('cte:order_supplies_summary', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('cte:joined', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('output:order_items', 'supply_cost'))).toBe(false)
    expect(path.edgeKeys.has('cte:supplies\0cte:order_supplies_summary')).toBe(true)

    const labels = path.steps.map(s => `${s.nodeId}:${s.column}`)
    expect(labels[0]).toBe('parent:stg_supplies:supply_cost')
    expect(labels.at(-1)).toBe('cte:joined:supply_cost')
    expect(path.steps.some(s => s.transformation === 'aggregated')).toBe(true)
  })

  it('returns focus only when lineage missing', () => {
    const path = collectColumnPath(undefined, 'cte:x', 'a')
    expect([...path.keys]).toEqual([colKey('cte:x', 'a')])
    expect(path.steps).toEqual([{ nodeId: 'cte:x', column: 'a' }])
  })

  it('highlights upstream expression inputs but not same-node siblings or downstream', () => {
    const winLineage: SqlGraphColumnLineage = {
      'cte:base': {
        customer_id: [{ source_node: 'parent:stg', source_column: 'customer_id', transformation: 'passthrough' }],
        ordered_at: [{ source_node: 'parent:stg', source_column: 'ordered_at', transformation: 'passthrough' }],
      },
      'cte:numbered': {
        customer_id: [{ source_node: 'cte:base', source_column: 'customer_id', transformation: 'passthrough' }],
        ordered_at: [{ source_node: 'cte:base', source_column: 'ordered_at', transformation: 'passthrough' }],
        n: [
          {
            source_node: 'cte:base',
            source_column: 'customer_id',
            transformation: 'derived',
            expression: 'ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY ordered_at)',
          },
          {
            source_node: 'cte:base',
            source_column: 'ordered_at',
            transformation: 'derived',
            expression: 'ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY ordered_at)',
          },
        ],
      },
      'output:m': {
        n: [{ source_node: 'cte:numbered', source_column: 'n', transformation: 'passthrough' }],
        customer_id: [{ source_node: 'cte:numbered', source_column: 'customer_id', transformation: 'passthrough' }],
      },
    }
    const path = collectColumnPath(winLineage, 'cte:numbered', 'n')
    expect(path.keys.has(colKey('cte:numbered', 'n'))).toBe(true)
    expect(path.keys.has(colKey('cte:base', 'customer_id'))).toBe(true)
    expect(path.keys.has(colKey('cte:base', 'ordered_at'))).toBe(true)
    expect(path.keys.has(colKey('parent:stg', 'customer_id'))).toBe(true)
    expect(path.keys.has(colKey('parent:stg', 'ordered_at'))).toBe(true)
    // same-node siblings + downstream stay dark
    expect(path.keys.has(colKey('cte:numbered', 'customer_id'))).toBe(false)
    expect(path.keys.has(colKey('cte:numbered', 'ordered_at'))).toBe(false)
    expect(path.keys.has(colKey('output:m', 'n'))).toBe(false)
    expect(path.keys.has(colKey('output:m', 'customer_id'))).toBe(false)
  })
})
