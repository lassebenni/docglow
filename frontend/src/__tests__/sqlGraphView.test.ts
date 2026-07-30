import { describe, expect, it } from 'vitest'
import type { SqlGraph } from '../types'
import {
  aggFnGlyph,
  collapsePassthroughCtes,
  cteFilterOps,
  filterOpColumns,
  highlightSelectSqlLines,
  joinHighlightFromNode,
} from '../utils/sqlGraphView'

const sample: SqlGraph = {
  nodes: [
    { id: 'parent:stg', kind: 'parent', label: 'stg', columns: ['id', 'x'] },
    { id: 'cte:pass', kind: 'cte', label: 'pass', passthrough: true, columns: ['id', 'x'] },
    {
      id: 'cte:calc',
      kind: 'cte',
      label: 'calc',
      columns: ['id', 'flag'],
      ops: [
        {
          id: 'cte:calc:op:0',
          kind: 'filter',
          label: 'where',
          expression: 'x > 0',
          columns: ['x'],
        },
      ],
      transforms: ['filter'],
    },
    {
      id: 'join:0:left',
      kind: 'join',
      label: 'left join',
      join_keys: [{ left_column: 'id', right_column: 'id' }],
    },
    { id: 'output:m', kind: 'output', label: 'm', columns: ['id', 'flag'] },
  ],
  edges: [
    { source: 'parent:stg', target: 'cte:pass' },
    { source: 'cte:pass', target: 'cte:calc' },
    { source: 'cte:calc', target: 'join:0:left' },
    { source: 'join:0:left', target: 'output:m' },
  ],
}

describe('collapsePassthroughCtes', () => {
  it('removes passthrough CTEs and rewires neighbors', () => {
    const g = collapsePassthroughCtes(sample)
    expect(g.nodes.find(n => n.id === 'cte:pass')).toBeUndefined()
    const edges = new Set(g.edges.map(e => `${e.source}->${e.target}`))
    expect(edges.has('parent:stg->cte:calc')).toBe(true)
    expect(edges.has('parent:stg->cte:pass')).toBe(false)
  })

  it('bridges parent through collapsed same-name passthrough CTE', () => {
    const g: SqlGraph = {
      nodes: [
        { id: 'parent:model.order_items', kind: 'parent', label: 'order_items', columns: ['order_id'] },
        {
          id: 'cte:order_items',
          kind: 'cte',
          label: 'order_items',
          passthrough: true,
          columns: ['order_id'],
        },
        {
          id: 'cte:order_items_summary',
          kind: 'cte',
          label: 'order_items_summary',
          transforms: ['aggregate'],
          columns: ['order_id'],
        },
      ],
      edges: [
        { source: 'parent:model.order_items', target: 'cte:order_items' },
        { source: 'cte:order_items', target: 'cte:order_items_summary' },
      ],
    }
    const collapsed = collapsePassthroughCtes(g)
    expect(collapsed.nodes.find(n => n.id === 'cte:order_items')).toBeUndefined()
    const edges = new Set(collapsed.edges.map(e => `${e.source}->${e.target}`))
    expect(edges.has('parent:model.order_items->cte:order_items_summary')).toBe(true)
  })
})

describe('joinHighlightFromNode', () => {
  it('returns join key columns and neighbors', () => {
    const join = sample.nodes.find(n => n.id === 'join:0:left')!
    const hl = joinHighlightFromNode(sample, join)
    expect(hl?.columns.has('id')).toBe(true)
    expect(hl?.nodeIds.has('cte:calc')).toBe(true)
    expect(hl?.nodeIds.has('output:m')).toBe(true)
  })
})

describe('aggFnGlyph', () => {
  it('maps agg tags to short labels', () => {
    expect(aggFnGlyph('sum')).toBe('SUM')
    expect(aggFnGlyph('count')).toBe('CNT')
    expect(aggFnGlyph('group')).toBe('GRP')
    expect(aggFnGlyph('none')).toBeNull()
  })
})

describe('highlightSelectSqlLines', () => {
  it('highlights the alias line for a column', () => {
    const sql = `SELECT
  order_id,
  SUM(supply_cost) AS order_cost,
  SUM(CASE WHEN is_food_item THEN 1 ELSE 0 END) AS count_food_items
FROM order_items
GROUP BY 1`
    const lines = highlightSelectSqlLines(sql, 'count_food_items')
    const hit = lines.filter(l => l.highlight)
    expect(hit).toHaveLength(1)
    expect(hit[0]?.text.toLowerCase()).toContain('count_food_items')
  })
})

describe('cte filter helpers', () => {
  it('lists filter ops and columns', () => {
    const calc = sample.nodes.find(n => n.id === 'cte:calc')!
    expect(cteFilterOps(calc)).toHaveLength(1)
    expect([...filterOpColumns(calc.ops)]).toEqual(['x'])
  })
})
