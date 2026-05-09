import { describe, it, expect } from 'vitest'
import { filterOrphans } from '../utils/erdOrphanFilter'
import type { DocglowModel } from '../types'

/**
 * Build a minimal `DocglowModel` shape sufficient for the filter. Only
 * `relationships_count` is consulted by the filter; the rest is padding so
 * TypeScript is happy. Cast to `DocglowModel` because the full shape is
 * not relevant here.
 */
function model(uid: string, count: number | undefined): DocglowModel {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    unique_id: uid,
    name: uid.split('.').pop() ?? uid,
    relationships_count: count,
  } as unknown as DocglowModel
}

describe('filterOrphans', () => {
  it('hides orphans by default (showOrphans = false)', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.a': model('model.p.a', 2),
      'model.p.b': model('model.p.b', 0),
      'model.p.c': model('model.p.c', 1),
    }
    const result = filterOrphans(['model.p.a', 'model.p.b', 'model.p.c'], models, false)
    expect(result).toEqual(['model.p.a', 'model.p.c'])
  })

  it('returns all models when toggle is on', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.a': model('model.p.a', 2),
      'model.p.b': model('model.p.b', 0),
      'model.p.c': model('model.p.c', 1),
    }
    const result = filterOrphans(['model.p.a', 'model.p.b', 'model.p.c'], models, true)
    expect(result).toEqual(['model.p.a', 'model.p.b', 'model.p.c'])
  })

  it('returns an empty array when every model is an orphan and toggle is off', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.a': model('model.p.a', 0),
      'model.p.b': model('model.p.b', 0),
    }
    const result = filterOrphans(['model.p.a', 'model.p.b'], models, false)
    expect(result).toEqual([])
  })

  it('returns all when every model is an orphan and toggle is on', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.a': model('model.p.a', 0),
      'model.p.b': model('model.p.b', 0),
    }
    const result = filterOrphans(['model.p.a', 'model.p.b'], models, true)
    expect(result).toEqual(['model.p.a', 'model.p.b'])
  })

  it('treats missing relationships_count as orphan (legacy data)', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.legacy': model('model.p.legacy', undefined),
      'model.p.connected': model('model.p.connected', 3),
    }
    const result = filterOrphans(
      ['model.p.legacy', 'model.p.connected'],
      models,
      false,
    )
    expect(result).toEqual(['model.p.connected'])
  })

  it('treats negative relationships_count as orphan (defensive)', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.weird': model('model.p.weird', -1),
      'model.p.ok': model('model.p.ok', 1),
    }
    const result = filterOrphans(['model.p.weird', 'model.p.ok'], models, false)
    expect(result).toEqual(['model.p.ok'])
  })

  it('preserves the input order', () => {
    const models: Record<string, DocglowModel> = {
      'z': model('z', 1),
      'a': model('a', 1),
      'm': model('m', 1),
    }
    const result = filterOrphans(['z', 'a', 'm'], models, false)
    expect(result).toEqual(['z', 'a', 'm'])
  })

  it('returns a NEW array (does not alias the input)', () => {
    const input = ['a', 'b']
    const models: Record<string, DocglowModel> = {
      a: model('a', 1),
      b: model('b', 1),
    }
    const result = filterOrphans(input, models, true)
    expect(result).not.toBe(input)
    expect(result).toEqual(input)
  })

  it('handles a uid that is not in the models map (treated as orphan)', () => {
    const models: Record<string, DocglowModel> = {
      'model.p.a': model('model.p.a', 1),
    }
    const result = filterOrphans(['model.p.a', 'model.p.missing'], models, false)
    expect(result).toEqual(['model.p.a'])
  })
})
