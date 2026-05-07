import { describe, it, expect } from 'vitest'
import { computeKeyColumns } from '../utils/erdKeys'
import type { DocglowModel, ColumnTest, DocglowColumn, ErdRelationship } from '../types'

function makeTest(test_name: string): ColumnTest {
  return {
    test_name,
    test_type: 'generic',
    status: 'pass',
    config: {},
  }
}

function makeColumn(name: string, tests: ColumnTest[] = []): DocglowColumn {
  return {
    name,
    description: '',
    data_type: 'varchar',
    meta: {},
    tags: [],
    tests,
    profile: null,
  }
}

function makeModel(unique_id: string, columns: DocglowColumn[]): DocglowModel {
  return {
    unique_id,
    name: unique_id.split('.').pop() ?? unique_id,
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
    columns,
    depends_on: [],
    referenced_by: [],
    sources_used: [],
    test_results: [],
    last_run: null,
    catalog_stats: { row_count: null, bytes: null, has_stats: false },
  }
}

function makeRelationship(overrides: Partial<ErdRelationship>): ErdRelationship {
  return {
    id: 'rel-1',
    from_unique_id: 'model.proj.orders',
    from_column: 'customer_id',
    to_unique_id: 'model.proj.customers',
    to_column: 'id',
    to_model_name: 'customers',
    kind: 'one_to_many',
    child_endpoint: 'one_and_only_one',
    parent_endpoint: 'one_or_many',
    inference_source: 'test',
    severity: 'warn',
    status: 'pass',
    label: null,
    test_unique_id: null,
    meta_file_path: null,
    is_synthetic: false,
    parent_column_exists: true,
    ...overrides,
  }
}

describe('computeKeyColumns', () => {
  it('returns only PK-style columns when there are no relationships', () => {
    const model = makeModel('model.proj.users', [
      makeColumn('id', [makeTest('unique'), makeTest('not_null')]),
      makeColumn('email', [makeTest('unique')]),
      makeColumn('name'),
    ])

    const result = computeKeyColumns(model, [])
    expect(result).toEqual(new Set(['id']))
  })

  it('includes a column that is from_column on an outgoing relationship', () => {
    const model = makeModel('model.proj.orders', [
      makeColumn('id'),
      makeColumn('customer_id'),
    ])
    const rels = [
      makeRelationship({
        from_unique_id: 'model.proj.orders',
        from_column: 'customer_id',
        to_unique_id: 'model.proj.customers',
        to_column: 'id',
      }),
    ]

    const result = computeKeyColumns(model, rels)
    expect(result.has('customer_id')).toBe(true)
    expect(result.has('id')).toBe(false)
  })

  it('includes a column that is to_column on an incoming relationship', () => {
    const model = makeModel('model.proj.customers', [
      makeColumn('id'),
      makeColumn('email'),
    ])
    const rels = [
      makeRelationship({
        from_unique_id: 'model.proj.orders',
        from_column: 'customer_id',
        to_unique_id: 'model.proj.customers',
        to_column: 'id',
      }),
    ]

    const result = computeKeyColumns(model, rels)
    expect(result.has('id')).toBe(true)
    expect(result.has('email')).toBe(false)
  })

  it('does NOT treat a column with only `unique` test (no not_null) as a key', () => {
    const model = makeModel('model.proj.users', [
      makeColumn('email', [makeTest('unique')]),
    ])
    const result = computeKeyColumns(model, [])
    expect(result.has('email')).toBe(false)
  })

  it('does NOT treat a column with only `not_null` test (no unique) as a key', () => {
    const model = makeModel('model.proj.users', [
      makeColumn('name', [makeTest('not_null')]),
    ])
    const result = computeKeyColumns(model, [])
    expect(result.has('name')).toBe(false)
  })

  it('treats a column with BOTH `unique` and `not_null` tests as a key', () => {
    const model = makeModel('model.proj.users', [
      makeColumn('id', [makeTest('unique'), makeTest('not_null')]),
    ])
    const result = computeKeyColumns(model, [])
    expect(result.has('id')).toBe(true)
  })

  it('dedupes when a column qualifies under multiple rules', () => {
    // `id` qualifies as PK (unique + not_null) AND as the to_column of an
    // incoming relationship — should appear once.
    const model = makeModel('model.proj.customers', [
      makeColumn('id', [makeTest('unique'), makeTest('not_null')]),
    ])
    const rels = [
      makeRelationship({
        from_unique_id: 'model.proj.orders',
        from_column: 'customer_id',
        to_unique_id: 'model.proj.customers',
        to_column: 'id',
      }),
    ]
    const result = computeKeyColumns(model, rels)
    expect(result.size).toBe(1)
    expect(result.has('id')).toBe(true)
  })

  it('ignores relationships that do not touch this model', () => {
    const model = makeModel('model.proj.orders', [
      makeColumn('id'),
      makeColumn('customer_id'),
    ])
    const rels = [
      makeRelationship({
        from_unique_id: 'model.proj.payments',
        from_column: 'order_id',
        to_unique_id: 'model.proj.unrelated',
        to_column: 'id',
      }),
    ]
    const result = computeKeyColumns(model, rels)
    expect(result.size).toBe(0)
  })

  it('handles a self-referential relationship (model is both endpoints)', () => {
    const model = makeModel('model.proj.employees', [
      makeColumn('id'),
      makeColumn('manager_id'),
    ])
    const rels = [
      makeRelationship({
        from_unique_id: 'model.proj.employees',
        from_column: 'manager_id',
        to_unique_id: 'model.proj.employees',
        to_column: 'id',
      }),
    ]
    const result = computeKeyColumns(model, rels)
    expect(result).toEqual(new Set(['manager_id', 'id']))
  })
})
