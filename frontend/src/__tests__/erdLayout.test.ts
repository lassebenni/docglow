import { describe, it, expect } from 'vitest'
import {
  computeErdLayout,
  TABLE_W,
  GAP_X,
  GAP_Y,
  ROW_SLOT_H,
  ORIGIN_OFFSET,
} from '../utils/erdLayout'

describe('computeErdLayout', () => {
  it('returns empty object for empty input', () => {
    expect(computeErdLayout([], {})).toEqual({})
  })

  it('places a single uid at the origin offset', () => {
    const result = computeErdLayout(['model.proj.a'], { 'model.proj.a': 0 })
    expect(result).toEqual({
      'model.proj.a': { x: ORIGIN_OFFSET, y: ORIGIN_OFFSET },
    })
  })

  it('lays out 4 uids in a 2x2 grid sorted by relationships_count desc', () => {
    const uids = ['model.proj.a', 'model.proj.b', 'model.proj.c', 'model.proj.d']
    const counts = {
      'model.proj.a': 1,
      'model.proj.b': 5, // highest → cell 0 (col 0, row 0)
      'model.proj.c': 3, // → cell 1 (col 1, row 0)
      'model.proj.d': 2, // → cell 2 (col 0, row 1)
    }
    const result = computeErdLayout(uids, counts)

    const cellW = TABLE_W + GAP_X
    const cellH = ROW_SLOT_H + GAP_Y

    // ceil(sqrt(4)) = 2 cols.
    expect(result['model.proj.b']).toEqual({ x: ORIGIN_OFFSET, y: ORIGIN_OFFSET })
    expect(result['model.proj.c']).toEqual({ x: cellW + ORIGIN_OFFSET, y: ORIGIN_OFFSET })
    expect(result['model.proj.d']).toEqual({ x: ORIGIN_OFFSET, y: cellH + ORIGIN_OFFSET })
    expect(result['model.proj.a']).toEqual({
      x: cellW + ORIGIN_OFFSET,
      y: cellH + ORIGIN_OFFSET,
    })
  })

  it('breaks ties alphabetically when relationships_count is equal', () => {
    const uids = ['model.proj.zebra', 'model.proj.apple', 'model.proj.mango']
    const counts = {
      'model.proj.zebra': 2,
      'model.proj.apple': 2,
      'model.proj.mango': 2,
    }
    const result = computeErdLayout(uids, counts)
    // ceil(sqrt(3)) = 2 cols. Sort: apple, mango, zebra.
    const cellW = TABLE_W + GAP_X
    const cellH = ROW_SLOT_H + GAP_Y

    expect(result['model.proj.apple']).toEqual({ x: ORIGIN_OFFSET, y: ORIGIN_OFFSET })
    expect(result['model.proj.mango']).toEqual({
      x: cellW + ORIGIN_OFFSET,
      y: ORIGIN_OFFSET,
    })
    expect(result['model.proj.zebra']).toEqual({
      x: ORIGIN_OFFSET,
      y: cellH + ORIGIN_OFFSET,
    })
  })

  it('treats missing counts as 0 for sort purposes', () => {
    const uids = ['model.proj.a', 'model.proj.b']
    // a has count 0 (missing), b has explicit 0 — alphabetical tiebreak applies.
    const result = computeErdLayout(uids, {})
    expect(result['model.proj.a']).toEqual({ x: ORIGIN_OFFSET, y: ORIGIN_OFFSET })
  })

  it('is deterministic — same input yields identical output across calls', () => {
    const uids = ['model.proj.x', 'model.proj.y', 'model.proj.z', 'model.proj.w']
    const counts = {
      'model.proj.x': 3,
      'model.proj.y': 1,
      'model.proj.z': 3,
      'model.proj.w': 5,
    }
    const a = computeErdLayout(uids, counts)
    const b = computeErdLayout(uids, counts)
    expect(a).toEqual(b)
  })

  it('does not mutate the input array', () => {
    const uids = ['model.proj.b', 'model.proj.a']
    const before = [...uids]
    computeErdLayout(uids, { 'model.proj.a': 5, 'model.proj.b': 1 })
    expect(uids).toEqual(before)
  })
})
