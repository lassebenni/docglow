import { describe, it, expect } from 'vitest'
import {
  getModelErdSubgraph,
  getReachableErdSubgraph,
} from '../utils/erdSubgraph'
import type { ErdRelationship } from '../types'

/**
 * Build a minimal `ErdRelationship` shape sufficient for the subgraph
 * filter. Only `id`, `from_unique_id`, and `to_unique_id` are consulted
 * by the helper — the rest is padding so TypeScript stays happy.
 */
function rel(
  id: string,
  from: string,
  to: string,
  overrides: Partial<ErdRelationship> = {},
): ErdRelationship {
  return {
    id,
    from_unique_id: from,
    from_column: 'fk',
    to_unique_id: to,
    to_column: 'pk',
    to_model_name: to.split('.').pop() ?? to,
    kind: 'one_to_many',
    child_endpoint: 'zero_or_many',
    parent_endpoint: 'one_and_only_one',
    inference_source: 'test',
    severity: 'error',
    status: 'pass',
    label: null,
    test_unique_id: null,
    meta_file_path: null,
    is_synthetic: false,
    parent_column_exists: true,
    ...overrides,
  }
}

const ORDERS = 'model.jaffle.orders'
const CUSTOMERS = 'model.jaffle.customers'
const ORDER_ITEMS = 'model.jaffle.order_items'
const PRODUCTS = 'model.jaffle.products'
const SUPPLIERS = 'model.jaffle.suppliers'

describe('getModelErdSubgraph', () => {
  it('includes both outgoing and incoming relationships of the focal model', () => {
    // orders → customers (outgoing), order_items → orders (incoming)
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDER_ITEMS, ORDERS),
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect([...result.models].sort()).toEqual(
      [ORDERS, CUSTOMERS, ORDER_ITEMS].sort(),
    )
  })

  it('does NOT include 2-hop edges between neighbors that bypass the focal model', () => {
    // orders ↔ customers (1-hop). customers ↔ suppliers is 2-hop and must NOT
    // appear in orders' subgraph even though customers IS a neighbor.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', CUSTOMERS, SUPPLIERS), // 2-hop — excluded
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id)).toEqual(['r1'])
    expect([...result.models].sort()).toEqual([ORDERS, CUSTOMERS].sort())
    expect(result.models.has(SUPPLIERS)).toBe(false)
  })

  it('returns empty result for a model with zero relationships', () => {
    const all: ErdRelationship[] = [
      rel('r1', CUSTOMERS, ORDER_ITEMS),
      rel('r2', PRODUCTS, ORDER_ITEMS),
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships).toEqual([])
    expect(result.models.size).toBe(0)
  })

  it('handles only-target model (no outgoing) — still includes parents pointing at it', () => {
    // orders, order_items both point AT customers. customers itself has no
    // outgoing edges. The subgraph for customers must still include both edges.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDER_ITEMS, CUSTOMERS),
      rel('r3', PRODUCTS, SUPPLIERS), // unrelated — excluded
    ]
    const result = getModelErdSubgraph(CUSTOMERS, all)
    expect(result.relationships.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect([...result.models].sort()).toEqual(
      [ORDERS, ORDER_ITEMS, CUSTOMERS].sort(),
    )
  })

  it('handles only-source model (no incoming) — still includes children', () => {
    // orders points at customers and order_items. Nothing points at orders.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDERS, ORDER_ITEMS),
      rel('r3', PRODUCTS, SUPPLIERS), // unrelated — excluded
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect([...result.models].sort()).toEqual(
      [ORDERS, CUSTOMERS, ORDER_ITEMS].sort(),
    )
  })

  it('includes a self-referential relationship exactly once', () => {
    // employees → employees (manager_id → id). Both endpoints are the focal
    // model; it must appear exactly once in the relationships array and the
    // models set must contain just the focal model.
    const EMPLOYEES = 'model.hr.employees'
    const all: ErdRelationship[] = [
      rel('r-self', EMPLOYEES, EMPLOYEES),
    ]
    const result = getModelErdSubgraph(EMPLOYEES, all)
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].id).toBe('r-self')
    expect([...result.models]).toEqual([EMPLOYEES])
  })

  it('includes ghost relationships (parent_column_exists === false)', () => {
    // Ghost edge: dbt declared the relationship but the parent column is
    // missing. The canvas/inspector handles its dashed rendering — the
    // subgraph helper just passes it through.
    const all: ErdRelationship[] = [
      rel('r-ghost', ORDERS, CUSTOMERS, { parent_column_exists: false }),
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id)).toEqual(['r-ghost'])
    expect([...result.models].sort()).toEqual([ORDERS, CUSTOMERS].sort())
  })

  it('includes ghost relationships with empty to_unique_id', () => {
    // Another ghost shape: the parent model itself is missing — to_unique_id
    // is the empty string. Still passed through; canvas filters at render.
    const all: ErdRelationship[] = [
      rel('r-ghost-target', ORDERS, '', { to_unique_id: '' }),
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id)).toEqual(['r-ghost-target'])
    expect(result.models.has(ORDERS)).toBe(true)
    expect(result.models.has('')).toBe(true)
  })

  it('returns empty result when allRelationships is empty', () => {
    const result = getModelErdSubgraph(ORDERS, [])
    expect(result.relationships).toEqual([])
    expect(result.models.size).toBe(0)
  })

  it('preserves input relationship order', () => {
    const all: ErdRelationship[] = [
      rel('r-c', ORDER_ITEMS, ORDERS),
      rel('r-a', ORDERS, CUSTOMERS),
      rel('r-b', ORDERS, PRODUCTS),
    ]
    const result = getModelErdSubgraph(ORDERS, all)
    expect(result.relationships.map((r) => r.id)).toEqual([
      'r-c',
      'r-a',
      'r-b',
    ])
  })
})

describe('getReachableErdSubgraph', () => {
  it('depth 1 returns root + immediate neighbors', () => {
    // orders ↔ customers, orders ↔ order_items. customers ↔ suppliers exists
    // but is 2-hop from orders, so it must NOT appear at depth 1.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDERS, ORDER_ITEMS),
      rel('r3', CUSTOMERS, SUPPLIERS),
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 1)
    expect([...result.models].sort()).toEqual(
      [ORDERS, CUSTOMERS, ORDER_ITEMS].sort(),
    )
    expect(result.relationships.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(result.models.has(SUPPLIERS)).toBe(false)
  })

  it('depth 2 returns 2-hop reachable set', () => {
    // orders -- customers -- suppliers. From orders @ depth 2 → suppliers in.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', CUSTOMERS, SUPPLIERS),
      rel('r3', SUPPLIERS, PRODUCTS), // 3-hop — NOT included
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 2)
    expect([...result.models].sort()).toEqual(
      [ORDERS, CUSTOMERS, SUPPLIERS].sort(),
    )
    expect(result.relationships.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect(result.models.has(PRODUCTS)).toBe(false)
  })

  it('depth 0 returns only the root, no relationships', () => {
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDERS, ORDER_ITEMS),
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 0)
    expect([...result.models]).toEqual([ORDERS])
    expect(result.relationships).toEqual([])
  })

  it('root with zero relationships returns just the root, no relationships', () => {
    // PRODUCTS appears nowhere in the relationship list.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', CUSTOMERS, ORDER_ITEMS),
    ]
    const result = getReachableErdSubgraph(PRODUCTS, all, 3)
    expect([...result.models]).toEqual([PRODUCTS])
    expect(result.relationships).toEqual([])
  })

  it('root not in any model (typo / stale URL) degrades gracefully', () => {
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDERS, ORDER_ITEMS),
    ]
    const ghostRoot = 'model.jaffle.does_not_exist'
    const result = getReachableErdSubgraph(ghostRoot, all, 2)
    expect([...result.models]).toEqual([ghostRoot])
    expect(result.relationships).toEqual([])
  })

  it('treats relationships as undirected (target → source reachable)', () => {
    // Edge declared as A → B. Root B at depth 1 must reach A.
    const all: ErdRelationship[] = [rel('r1', ORDERS, CUSTOMERS)]
    const result = getReachableErdSubgraph(CUSTOMERS, all, 1)
    expect([...result.models].sort()).toEqual([CUSTOMERS, ORDERS].sort())
    expect(result.relationships.map((r) => r.id)).toEqual(['r1'])
  })

  it('depth >= max-reachable returns the full connected component', () => {
    // A ↔ B ↔ C ↔ D. depth 99 from A returns {A, B, C, D} and all 3 edges.
    const A = 'model.x.a'
    const B = 'model.x.b'
    const C = 'model.x.c'
    const D = 'model.x.d'
    const all: ErdRelationship[] = [
      rel('ab', A, B),
      rel('bc', B, C),
      rel('cd', C, D),
    ]
    const result = getReachableErdSubgraph(A, all, 99)
    expect([...result.models].sort()).toEqual([A, B, C, D].sort())
    expect(result.relationships.map((r) => r.id).sort()).toEqual([
      'ab',
      'bc',
      'cd',
    ])
  })

  it('disconnected components stay disconnected even at large depth', () => {
    // Two islands: {orders, customers} and {products, suppliers}. No path
    // between them; depth 99 from orders must NOT reach products/suppliers.
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', PRODUCTS, SUPPLIERS),
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 99)
    expect([...result.models].sort()).toEqual([ORDERS, CUSTOMERS].sort())
    expect(result.models.has(PRODUCTS)).toBe(false)
    expect(result.models.has(SUPPLIERS)).toBe(false)
    expect(result.relationships.map((r) => r.id)).toEqual(['r1'])
  })

  it('includes a self-referential relationship at root exactly once', () => {
    const EMPLOYEES = 'model.hr.employees'
    const all: ErdRelationship[] = [rel('r-self', EMPLOYEES, EMPLOYEES)]
    const result = getReachableErdSubgraph(EMPLOYEES, all, 2)
    expect([...result.models]).toEqual([EMPLOYEES])
    expect(result.relationships).toHaveLength(1)
    expect(result.relationships[0].id).toBe('r-self')
  })

  it('includes ghost relationships (parent_column_exists === false)', () => {
    const all: ErdRelationship[] = [
      rel('r-ghost', ORDERS, CUSTOMERS, { parent_column_exists: false }),
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 1)
    expect(result.relationships.map((r) => r.id)).toEqual(['r-ghost'])
    expect([...result.models].sort()).toEqual([ORDERS, CUSTOMERS].sort())
  })

  it('does not duplicate edges where both endpoints are reached at the same hop', () => {
    // Two parallel relationships between the same pair of models — both
    // must appear, but each only once. (Distinct ids → distinct relationships.)
    const all: ErdRelationship[] = [
      rel('r1', ORDERS, CUSTOMERS),
      rel('r2', ORDERS, CUSTOMERS),
    ]
    const result = getReachableErdSubgraph(ORDERS, all, 1)
    expect(result.relationships.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    expect([...result.models].sort()).toEqual([ORDERS, CUSTOMERS].sort())
  })
})
