import { describe, it, expect } from 'vitest'
import {
  basenameUniqueId,
  resolveModelName,
  synthesizeRelationshipYaml,
} from '../components/erd/ErdInspector'
import type { DocglowModel } from '../types'

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
