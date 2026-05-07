import { describe, it, expect } from 'vitest'
import {
  basenameUniqueId,
  partitionRelationshipsForNode,
  resolveModelName,
  synthesizeRelationshipYaml,
} from '../components/erd/ErdInspector'
import type { DocglowModel, ErdRelationship } from '../types'

/* No @testing-library/react in this repo and vitest runs in `node` env, so
   we exercise the inspector via its pure helpers. The render branches
   themselves are simple type-driven switches over the helpers tested here. */

describe('synthesizeRelationshipYaml', () => {
  const base = {
    fromColumn: 'customer_id',
    toColumn: 'id',
    toModelName: 'customers',
    toUniqueId: 'model.jaffle_shop.customers',
  }

  it('renders a relationships test snippet for inference_source=test', () => {
    const yaml = synthesizeRelationshipYaml({
      ...base,
      inferenceSource: 'test',
    })
    expect(yaml).toBe(
      [
        '- relationships:',
        "    to: ref('customers')",
        '    field: id',
      ].join('\n'),
    )
  })

  it('renders a relationships test snippet for inference_source=both', () => {
    const yaml = synthesizeRelationshipYaml({
      ...base,
      inferenceSource: 'both',
    })
    // `both` still emits the test block — the test wins per §5.4.
    expect(yaml).toContain('- relationships:')
    expect(yaml).toContain("to: ref('customers')")
    expect(yaml).toContain('field: id')
    expect(yaml).not.toContain('meta:')
  })

  it('renders a meta.docglow snippet for inference_source=meta', () => {
    const yaml = synthesizeRelationshipYaml({
      ...base,
      inferenceSource: 'meta',
    })
    expect(yaml).toBe(
      [
        'meta:',
        '  docglow:',
        '    relationships:',
        '      - to: model.jaffle_shop.customers',
        '        from_column: customer_id',
        '        to_column: id',
      ].join('\n'),
    )
  })

  it('keeps test/meta outputs distinct for the same inputs', () => {
    const t = synthesizeRelationshipYaml({ ...base, inferenceSource: 'test' })
    const m = synthesizeRelationshipYaml({ ...base, inferenceSource: 'meta' })
    expect(t).not.toEqual(m)
  })
})

describe('basenameUniqueId', () => {
  it('returns null for null input', () => {
    expect(basenameUniqueId(null)).toBeNull()
  })

  it('extracts the trailing dotted segment', () => {
    expect(
      basenameUniqueId('test.jaffle_shop.relationships_orders_customer_id'),
    ).toBe('relationships_orders_customer_id')
  })

  it('returns the input itself when no dots are present', () => {
    expect(basenameUniqueId('orphan_id')).toBe('orphan_id')
  })
})

describe('resolveModelName', () => {
  function makeModel(unique_id: string, name: string): DocglowModel {
    return {
      unique_id,
      name,
      description: '',
      schema: 'public',
      database: 'analytics',
      materialization: 'table',
      tags: [],
      meta: {},
      path: '',
      folder: '',
      raw_sql: '',
      compiled_sql: '',
      columns: [],
      depends_on: [],
      referenced_by: [],
      sources_used: [],
      test_results: [],
      last_run: null,
      catalog_stats: { row_count: null, bytes: null, has_stats: false },
    }
  }

  it('returns model.name when the model is in the payload', () => {
    const models = {
      'model.jaffle_shop.customers': makeModel(
        'model.jaffle_shop.customers',
        'customers',
      ),
    }
    expect(resolveModelName('model.jaffle_shop.customers', models)).toBe(
      'customers',
    )
  })

  it('falls back to the trailing dotted segment when the model is missing', () => {
    expect(resolveModelName('model.unknown.ghost_table', {})).toBe(
      'ghost_table',
    )
  })

  it('returns the raw id when there are no dots', () => {
    expect(resolveModelName('weird_id', {})).toBe('weird_id')
  })
})

/* ------------------------------------------------------------------ */
/* Node-branch helper (DOC-216 U2).                                    */
/* ------------------------------------------------------------------ */

describe('partitionRelationshipsForNode', () => {
  function makeRel(
    overrides: Partial<ErdRelationship> & {
      readonly id: string
      readonly from_unique_id: string
      readonly to_unique_id: string
    },
  ): ErdRelationship {
    return {
      id: overrides.id,
      from_unique_id: overrides.from_unique_id,
      from_column: overrides.from_column ?? 'fk',
      to_unique_id: overrides.to_unique_id,
      to_column: overrides.to_column ?? 'id',
      to_model_name: overrides.to_model_name ?? 'parent',
      kind: overrides.kind ?? 'one_to_many',
      child_endpoint: overrides.child_endpoint ?? 'one_or_many',
      parent_endpoint: overrides.parent_endpoint ?? 'one_and_only_one',
      inference_source: overrides.inference_source ?? 'test',
      severity: overrides.severity ?? 'error',
      status: overrides.status ?? 'pass',
      label: overrides.label ?? null,
      test_unique_id: overrides.test_unique_id ?? null,
      meta_file_path: overrides.meta_file_path ?? null,
      is_synthetic: overrides.is_synthetic ?? false,
      parent_column_exists: overrides.parent_column_exists ?? true,
    }
  }

  const ORDERS = 'model.jaffle_shop.orders'
  const CUSTOMERS = 'model.jaffle_shop.customers'
  const ITEMS = 'model.jaffle_shop.order_items'

  const rels: readonly ErdRelationship[] = [
    makeRel({
      id: 'rel.orders__customers',
      from_unique_id: ORDERS,
      to_unique_id: CUSTOMERS,
      from_column: 'customer_id',
      to_column: 'id',
    }),
    makeRel({
      id: 'rel.items__orders',
      from_unique_id: ITEMS,
      to_unique_id: ORDERS,
      from_column: 'order_id',
      to_column: 'id',
    }),
    makeRel({
      id: 'rel.unrelated',
      from_unique_id: 'model.x.a',
      to_unique_id: 'model.x.b',
    }),
  ]

  it('splits outgoing vs incoming for a middle node', () => {
    const { outgoing, incoming } = partitionRelationshipsForNode(ORDERS, rels)
    expect(outgoing.map((r) => r.id)).toEqual(['rel.orders__customers'])
    expect(incoming.map((r) => r.id)).toEqual(['rel.items__orders'])
  })

  it('returns empty incoming for a leaf source node', () => {
    const { outgoing, incoming } = partitionRelationshipsForNode(ITEMS, rels)
    expect(outgoing.map((r) => r.id)).toEqual(['rel.items__orders'])
    expect(incoming).toEqual([])
  })

  it('returns empty outgoing for a leaf parent node', () => {
    const { outgoing, incoming } = partitionRelationshipsForNode(CUSTOMERS, rels)
    expect(outgoing).toEqual([])
    expect(incoming.map((r) => r.id)).toEqual(['rel.orders__customers'])
  })

  it('returns both empty for a node with no relationships', () => {
    const { outgoing, incoming } = partitionRelationshipsForNode(
      'model.unknown.ghost',
      rels,
    )
    expect(outgoing).toEqual([])
    expect(incoming).toEqual([])
  })

  it('places a self-referential relationship in BOTH buckets', () => {
    const SELF = 'model.proj.employees'
    const selfRels: readonly ErdRelationship[] = [
      makeRel({
        id: 'rel.self',
        from_unique_id: SELF,
        to_unique_id: SELF,
        from_column: 'manager_id',
        to_column: 'id',
      }),
    ]
    const { outgoing, incoming } = partitionRelationshipsForNode(SELF, selfRels)
    expect(outgoing.map((r) => r.id)).toEqual(['rel.self'])
    expect(incoming.map((r) => r.id)).toEqual(['rel.self'])
  })

  it('preserves the input order in each bucket', () => {
    const NODE = 'model.proj.hub'
    const ordered: readonly ErdRelationship[] = [
      makeRel({ id: 'out-a', from_unique_id: NODE, to_unique_id: 'model.x.p1' }),
      makeRel({ id: 'in-a', from_unique_id: 'model.x.c1', to_unique_id: NODE }),
      makeRel({ id: 'out-b', from_unique_id: NODE, to_unique_id: 'model.x.p2' }),
      makeRel({ id: 'in-b', from_unique_id: 'model.x.c2', to_unique_id: NODE }),
    ]
    const { outgoing, incoming } = partitionRelationshipsForNode(NODE, ordered)
    expect(outgoing.map((r) => r.id)).toEqual(['out-a', 'out-b'])
    expect(incoming.map((r) => r.id)).toEqual(['in-a', 'in-b'])
  })
})
