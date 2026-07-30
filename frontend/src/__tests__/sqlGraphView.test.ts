import { describe, expect, it } from 'vitest'
import type { SqlGraph } from '../types'
import {
  collapsePassthroughCtes,
  findDefiningOps,
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
          kind: 'derived',
          label: 'derived',
          expression: 'x > 0',
          columns: ['flag'],
        },
      ],
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
})

describe('findDefiningOps', () => {
  it('finds derived op for column', () => {
    const hits = findDefiningOps(sample, 'flag')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.op.expression).toBe('x > 0')
    expect(hits[0]?.cteId).toBe('cte:calc')
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
