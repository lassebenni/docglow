import { describe, it, expect } from 'vitest'
import { getModelErdSubgraph } from '../utils/erdSubgraph'
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
