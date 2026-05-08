import { describe, it, expect } from 'vitest'
import {
  pickHandlePair,
  SELF_LOOP_HANDLES,
} from '../utils/erdEdgeMapping'

describe('pickHandlePair', () => {
  it('attaches source-right → target-left when source is left of target', () => {
    expect(pickHandlePair(0, 100)).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
    })
  })

  it('attaches source-left → target-right when source is right of target', () => {
    expect(pickHandlePair(500, 100)).toEqual({
      sourceHandle: 'source-left',
      targetHandle: 'target-right',
    })
  })

  it('breaks ties (equal x) by routing right → left', () => {
    // Stable tiebreak — happens when nodes share a column. Either choice
    // works; locking it down prevents flip-flop.
    expect(pickHandlePair(200, 200)).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
    })
  })

  it('handles negative coordinates', () => {
    expect(pickHandlePair(-100, -50)).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
    })
    expect(pickHandlePair(-50, -100)).toEqual({
      sourceHandle: 'source-left',
      targetHandle: 'target-right',
    })
  })
})

describe('SELF_LOOP_HANDLES', () => {
  it('routes both ends through right-side handles for self-referential edges', () => {
    expect(SELF_LOOP_HANDLES).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-right',
    })
  })
})
