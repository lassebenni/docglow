import { describe, it, expect } from 'vitest'
import { computeErdSuggestions } from '../utils/erdSuggestions'
import type { DocglowModel } from '../types'

/**
 * Build a minimal `DocglowModel` shape sufficient for the suggestions
 * helper. Only `name`, `folder`, and `relationships_count` are consulted —
 * the rest is padding so TypeScript stays happy.
 */
function model(
  uniqueId: string,
  name: string,
  folder: string,
  relationshipsCount: number | undefined,
): DocglowModel {
  // Cast through `unknown` — the shared-types `DocglowModel` interface has
  // dozens of required fields (catalog_stats, columns, etc.) that the
  // helper never reads. Padding them all here would bury the test signal.
  return {
    unique_id: uniqueId,
    name,
    folder,
    relationships_count: relationshipsCount,
  } as unknown as DocglowModel
}

describe('computeErdSuggestions', () => {
  it('ranks models by relationships_count descending', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'orders', 'marts/core', 5),
      b: model('b', 'customers', 'marts/core', 10),
      c: model('c', 'products', 'marts/core', 3),
    }
    const result = computeErdSuggestions(models)
    expect(result.map((r) => r.uniqueId)).toEqual(['b', 'a', 'c'])
    expect(result[0].relationshipsCount).toBe(10)
  })

  it('alphabetical tiebreak on equal relationships_count', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'zeta', 'm', 3),
      b: model('b', 'alpha', 'm', 3),
      c: model('c', 'mike', 'm', 3),
    }
    const result = computeErdSuggestions(models)
    expect(result.map((r) => r.name)).toEqual(['alpha', 'mike', 'zeta'])
  })

  it('keeps models with zero relationships but sorts them to the bottom', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'orders', 'marts/core', 5),
      b: model('b', 'orphan', 'staging', 0),
      c: model('c', 'customers', 'marts/core', 2),
    }
    const result = computeErdSuggestions(models)
    expect(result.map((r) => r.uniqueId)).toEqual(['a', 'c', 'b'])
    expect(result[2].relationshipsCount).toBe(0)
  })

  it('treats missing relationships_count as 0', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'orders', 'm', undefined),
      b: model('b', 'customers', 'm', 4),
    }
    const result = computeErdSuggestions(models)
    expect(result.map((r) => r.uniqueId)).toEqual(['b', 'a'])
    expect(result[1].relationshipsCount).toBe(0)
  })

  it('takes top 12 by default', () => {
    const models: Record<string, DocglowModel> = {}
    for (let i = 0; i < 20; i++) {
      const id = `model_${String(i).padStart(2, '0')}`
      models[id] = model(id, id, 'm', i)
    }
    const result = computeErdSuggestions(models)
    expect(result).toHaveLength(12)
    // Highest 12 counts → indices 19 down to 8
    expect(result[0].uniqueId).toBe('model_19')
    expect(result[11].uniqueId).toBe('model_08')
  })

  it('honors a custom topN argument', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'a', 'm', 5),
      b: model('b', 'b', 'm', 4),
      c: model('c', 'c', 'm', 3),
    }
    const result = computeErdSuggestions(models, 2)
    expect(result.map((r) => r.uniqueId)).toEqual(['a', 'b'])
  })

  it('returns empty array for empty input', () => {
    const result = computeErdSuggestions({})
    expect(result).toEqual([])
  })

  it('preserves folder on the suggestion record', () => {
    const models: Record<string, DocglowModel> = {
      a: model('a', 'orders', 'marts/finance', 3),
    }
    const result = computeErdSuggestions(models)
    expect(result[0]).toEqual({
      uniqueId: 'a',
      name: 'orders',
      folder: 'marts/finance',
      relationshipsCount: 3,
    })
  })
})
