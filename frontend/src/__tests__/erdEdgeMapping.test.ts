import { describe, it, expect } from 'vitest'
import {
  pickHandlePair,
  pickEdgeHandles,
  pickSelfLoopHandles,
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

describe('pickEdgeHandles', () => {
  it('falls back to generic side handles when both nodes are compact', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'compact',
        toState: 'compact',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'customer_id',
        toColumn: 'customer_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
    })
  })

  it('uses per-column handles when both nodes are in keys state and columns are rendered', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'keys',
        toState: 'keys',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'customer_id',
        toColumn: 'customer_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right-customer_id',
      targetHandle: 'target-left-customer_id',
    })
  })

  it('uses per-column handles in full state too', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'full',
        toState: 'full',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'order_id',
        toColumn: 'id',
      }),
    ).toEqual({
      sourceHandle: 'source-right-order_id',
      targetHandle: 'target-left-id',
    })
  })

  it('mirrors sides when source is right of target', () => {
    expect(
      pickEdgeHandles({
        fromX: 500,
        toX: 100,
        fromState: 'keys',
        toState: 'keys',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'customer_id',
        toColumn: 'customer_id',
      }),
    ).toEqual({
      sourceHandle: 'source-left-customer_id',
      targetHandle: 'target-right-customer_id',
    })
  })

  it('falls back to generic when from-column is not rendered', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'keys',
        toState: 'keys',
        fromHasColumn: false,
        toHasColumn: true,
        fromColumn: 'mystery_col',
        toColumn: 'customer_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left-customer_id',
    })
  })

  it('falls back to generic when to-column is not rendered', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'keys',
        toState: 'keys',
        fromHasColumn: true,
        toHasColumn: false,
        fromColumn: 'customer_id',
        toColumn: 'mystery_col',
      }),
    ).toEqual({
      sourceHandle: 'source-right-customer_id',
      targetHandle: 'target-left',
    })
  })

  it('mixes per-column and generic when one side is compact', () => {
    expect(
      pickEdgeHandles({
        fromX: 0,
        toX: 100,
        fromState: 'keys',
        toState: 'compact',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'customer_id',
        toColumn: 'customer_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right-customer_id',
      targetHandle: 'target-left',
    })
  })
})

describe('pickSelfLoopHandles', () => {
  it('falls back to generic right-side handles for compact self-loops', () => {
    expect(
      pickSelfLoopHandles({
        state: 'compact',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'manager_id',
        toColumn: 'employee_id',
      }),
    ).toEqual(SELF_LOOP_HANDLES)
  })

  it('uses per-column right-side handles when columns are rendered', () => {
    expect(
      pickSelfLoopHandles({
        state: 'keys',
        fromHasColumn: true,
        toHasColumn: true,
        fromColumn: 'manager_id',
        toColumn: 'employee_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right-manager_id',
      targetHandle: 'target-right-employee_id',
    })
  })

  it('falls back per-side when column is missing', () => {
    expect(
      pickSelfLoopHandles({
        state: 'keys',
        fromHasColumn: true,
        toHasColumn: false,
        fromColumn: 'manager_id',
        toColumn: 'employee_id',
      }),
    ).toEqual({
      sourceHandle: 'source-right-manager_id',
      targetHandle: 'target-right',
    })
  })
})
