import { describe, expect, it } from 'vitest'
import {
  collectColumnDownstream,
  collectColumnPath,
  collectColumnUpstream,
  colKey,
} from '../utils/sqlGraphColumns'
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
  it('traces supply_cost upstream and downstream of the focus column', () => {
    const path = collectColumnPath(lineage, 'cte:joined', 'supply_cost')
    expect(path.keys.has(colKey('parent:stg_supplies', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('cte:order_supplies_summary', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('cte:joined', 'supply_cost'))).toBe(true)
    expect(path.keys.has(colKey('output:order_items', 'supply_cost'))).toBe(true)
    expect(path.edgeKeys.has('cte:supplies\0cte:order_supplies_summary')).toBe(true)
    expect(path.columnEdges.length).toBeGreaterThan(0)
    expect(path.columnColors.size).toBeGreaterThan(0)

    const labels = path.steps.map(s => `${s.nodeId}:${s.column}`)
    expect(labels[0]).toBe('parent:stg_supplies:supply_cost')
    expect(labels.at(-1)).toBe('output:order_items:supply_cost')
    expect(path.steps.some(s => s.transformation === 'aggregated')).toBe(true)
  })

  it('returns focus only when lineage missing', () => {
    const path = collectColumnPath(undefined, 'cte:x', 'a')
    expect([...path.keys]).toEqual([colKey('cte:x', 'a')])
    expect(path.steps).toEqual([{ nodeId: 'cte:x', column: 'a' }])
    expect(path.columnEdges).toEqual([])
  })

  it('assigns distinct branch colors for multi-input aggregates', () => {
    const multi: SqlGraphColumnLineage = {
      'cte:pos_lines': {
        amt_sales_excl_vat: [
          { source_node: 'parent:fct', source_column: 'amt_sales_excl_vat', transformation: 'passthrough' },
        ],
        is_service: [
          { source_node: 'parent:fct', source_column: 'is_service', transformation: 'passthrough' },
        ],
        is_voucher: [
          { source_node: 'parent:fct', source_column: 'is_voucher', transformation: 'passthrough' },
        ],
      },
      'cte:line_rollup': {
        amt_item_sales_excl_vat: [
          {
            source_node: 'cte:pos_lines',
            source_column: 'amt_sales_excl_vat',
            transformation: 'aggregated',
          },
          {
            source_node: 'cte:pos_lines',
            source_column: 'is_service',
            transformation: 'aggregated',
          },
          {
            source_node: 'cte:pos_lines',
            source_column: 'is_voucher',
            transformation: 'aggregated',
          },
        ],
      },
    }
    const path = collectColumnPath(multi, 'cte:line_rollup', 'amt_item_sales_excl_vat')
    const c1 = path.columnColors.get('cte:pos_lines')?.get('amt_sales_excl_vat')
    const c2 = path.columnColors.get('cte:pos_lines')?.get('is_service')
    const c3 = path.columnColors.get('cte:pos_lines')?.get('is_voucher')
    expect(c1).toBeTruthy()
    expect(c2).toBeTruthy()
    expect(c3).toBeTruthy()
    expect(new Set([c1, c2, c3]).size).toBe(3)
    expect(path.columnColors.get('cte:line_rollup')?.get('amt_item_sales_excl_vat')).toBe(
      '#f59e0b',
    )
  })

  it('highlights upstream inputs + focus downstream, not same-node siblings', () => {
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
    // focus flows downstream
    expect(path.keys.has(colKey('output:m', 'n'))).toBe(true)
    // same-node siblings + their downstream stay dark
    expect(path.keys.has(colKey('cte:numbered', 'customer_id'))).toBe(false)
    expect(path.keys.has(colKey('cte:numbered', 'ordered_at'))).toBe(false)
    expect(path.keys.has(colKey('output:m', 'customer_id'))).toBe(false)
  })

  it('collectColumnDownstream lists immediate consumers', () => {
    const down = collectColumnDownstream(lineage, 'cte:joined', 'supply_cost')
    expect(down).toEqual([
      { nodeId: 'output:order_items', column: 'supply_cost', transformation: 'passthrough' },
    ])
  })

  it('collectColumnUpstream walks recursively nearest-first', () => {
    const up = collectColumnUpstream(lineage, 'output:order_items', 'supply_cost')
    expect(up.map(h => `${h.nodeId}:${h.column}`)).toEqual([
      'cte:joined:supply_cost',
      'cte:order_supplies_summary:supply_cost',
      'cte:supplies:supply_cost',
      'parent:stg_supplies:supply_cost',
    ])
  })

  it('skips constant deps with empty source_column when walking upstream', () => {
    const constLineage: SqlGraphColumnLineage = {
      'cte:line_rollup': {
        amt_employee_discount_excl_vat: [
          {
            source_node: 'cte:pos_lines',
            source_column: '',
            transformation: 'constant',
            expression: 'CAST(0 AS DECIMAL(18, 2))',
          },
        ],
        amt_cogs_excl_vat: [
          {
            source_node: 'cte:pos_lines',
            source_column: 'amt_cogs_excl_vat',
            transformation: 'aggregated',
            expression: 'SUM(amt_cogs_excl_vat)',
          },
        ],
      },
      'cte:pos_lines': {
        amt_cogs_excl_vat: [
          {
            source_node: 'parent:fct',
            source_column: 'amt_cogs_excl_vat',
            transformation: 'passthrough',
          },
        ],
      },
    }
    const constantPath = collectColumnPath(
      constLineage,
      'cte:line_rollup',
      'amt_employee_discount_excl_vat',
    )
    expect([...constantPath.keys]).toEqual([
      colKey('cte:line_rollup', 'amt_employee_discount_excl_vat'),
    ])
    expect(constantPath.edgeKeys.size).toBe(0)

    const aggPath = collectColumnPath(constLineage, 'cte:line_rollup', 'amt_cogs_excl_vat')
    expect(aggPath.keys.has(colKey('cte:pos_lines', 'amt_cogs_excl_vat'))).toBe(true)
    expect(aggPath.keys.has(colKey('parent:fct', 'amt_cogs_excl_vat'))).toBe(true)
  })
})
