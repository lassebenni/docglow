/**
 * Tests for the `showParentSiblings` flag on `getSubgraph` — the "Parent
 * outputs" injection ported from vt-dbt's `patch_lineage_parent_siblings_inject`.
 *
 * Scenario shape:
 *
 *     stg_a ─┬─► fct_focal
 *            ├─► fct_sib1
 *            └─► fct_sib2
 *     stg_b ──► fct_focal
 *     stg_c ──► fct_unrelated   (different parent chain — must NOT be pulled in)
 */
import { describe, it, expect } from 'vitest'
import { getSubgraph } from '../utils/graph'
import type { LineageEdge, LineageNode } from '../types'

function node(id: string): LineageNode {
  return {
    id,
    name: id,
    resource_type: 'model',
    materialization: 'table',
    schema: 'analytics',
    test_status: 'none',
    has_description: false,
    folder: '',
    tags: [],
  }
}

const nodes: LineageNode[] = [
  node('stg_a'),
  node('stg_b'),
  node('stg_c'),
  node('fct_focal'),
  node('fct_sib1'),
  node('fct_sib2'),
  node('fct_unrelated'),
]

const edges: LineageEdge[] = [
  { source: 'stg_a', target: 'fct_focal' },
  { source: 'stg_a', target: 'fct_sib1' },
  { source: 'stg_a', target: 'fct_sib2' },
  { source: 'stg_b', target: 'fct_focal' },
  { source: 'stg_c', target: 'fct_unrelated' },
]

describe('getSubgraph showParentSiblings', () => {
  it('omits siblings when the flag is off (default)', () => {
    const result = getSubgraph('fct_focal', nodes, edges, 1, 'both')
    const ids = result.nodes.map((n) => n.id).sort()
    expect(ids).toContain('fct_focal')
    expect(ids).toContain('stg_a')
    expect(ids).toContain('stg_b')
    expect(ids).not.toContain('fct_sib1')
    expect(ids).not.toContain('fct_sib2')
  })

  it('injects siblings when the flag is on', () => {
    const result = getSubgraph('fct_focal', nodes, edges, 1, 'both', 1, 1, true)
    const ids = new Set(result.nodes.map((n) => n.id))
    expect(ids.has('fct_focal')).toBe(true)
    expect(ids.has('stg_a')).toBe(true)
    expect(ids.has('stg_b')).toBe(true)
    expect(ids.has('fct_sib1')).toBe(true)
    expect(ids.has('fct_sib2')).toBe(true)
  })

  it('does NOT inject children of parents that fall outside the depth window', () => {
    const result = getSubgraph('fct_focal', nodes, edges, 1, 'both', 1, 1, true)
    const ids = new Set(result.nodes.map((n) => n.id))
    // stg_c is not a parent of focal at all; its child fct_unrelated must
    // not leak into the subgraph just because the flag is on.
    expect(ids.has('stg_c')).toBe(false)
    expect(ids.has('fct_unrelated')).toBe(false)
  })

  it('adds the parent→sibling edges in addition to the parent→focal edges', () => {
    const result = getSubgraph('fct_focal', nodes, edges, 1, 'both', 1, 1, true)
    const edgeKeys = result.edges.map((e) => `${e.source}->${e.target}`).sort()
    expect(edgeKeys).toContain('stg_a->fct_focal')
    expect(edgeKeys).toContain('stg_a->fct_sib1')
    expect(edgeKeys).toContain('stg_a->fct_sib2')
    expect(edgeKeys).toContain('stg_b->fct_focal')
    // No edge to stg_c's universe.
    expect(edgeKeys).not.toContain('stg_c->fct_unrelated')
  })

  it('does not duplicate an edge that the main BFS already kept', () => {
    const result = getSubgraph('fct_focal', nodes, edges, 1, 'both', 1, 1, true)
    const counts = new Map<string, number>()
    for (const e of result.edges) {
      const k = `${e.source}->${e.target}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    for (const [, n] of counts) expect(n).toBe(1)
  })
})
