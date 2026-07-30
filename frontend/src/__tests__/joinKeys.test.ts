import { describe, it, expect } from 'vitest'
import type { JoinKeysData, LineageEdge } from '../types'
import {
  connectedEndpointJoinKeyHighlights,
  formatJoinPredicate,
  formatJoinTypeBadge,
  getJoinKeysForEdge,
  joinKeyHighlightSets,
  joinedParentBadgesForFocus,
} from '../utils/joinKeys'

describe('getJoinKeysForEdge', () => {
  it('returns edge-embedded join keys oriented source → target', () => {
    const edge: LineageEdge = {
      source: 'model.a',
      target: 'model.b',
      join_keys: [{ source_column: 'id', target_column: 'a_id' }],
    }
    expect(getJoinKeysForEdge('model.a', 'model.b', edge, null)).toEqual([
      { source_column: 'id', target_column: 'a_id' },
    ])
  })

  it('orients pairs from join_keys map to match edge direction', () => {
    const joinKeys: JoinKeysData = {
      'model.b': [
        {
          left_model: 'model.b',
          left_column: 'user_id',
          right_model: 'model.a',
          right_column: 'id',
          join_type: 'left',
        },
      ],
    }
    const pairs = getJoinKeysForEdge('model.a', 'model.b', undefined, joinKeys)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].source_column).toBe('id')
    expect(pairs[0].target_column).toBe('user_id')
    expect(pairs[0].join_type).toBe('left')
  })

  it('returns empty when no matching pairs', () => {
    expect(getJoinKeysForEdge('model.a', 'model.b', { source: 'model.a', target: 'model.b' }, {})).toEqual([])
  })
})

describe('joinKeyHighlightSets', () => {
  it('maps columns onto both endpoints', () => {
    const map = joinKeyHighlightSets(
      [
        { source_column: 'size_code', target_column: 'size_code' },
        { source_column: 'group_code', target_column: 'group_code' },
      ],
      'model.sku',
      'model.size',
    )
    expect([...map.get('model.sku')!].sort()).toEqual(['group_code', 'size_code'])
    expect([...map.get('model.size')!].sort()).toEqual(['group_code', 'size_code'])
  })
})

describe('connectedEndpointJoinKeyHighlights', () => {
  it('highlights when both endpoints are in the visible subgraph', () => {
    const joinKeys: JoinKeysData = {
      'model.fact': [
        {
          left_model: 'model.sku',
          left_column: 'size_code',
          right_model: 'model.size',
          right_column: 'size_code',
        },
        {
          left_model: 'model.sku',
          left_column: 'group_code',
          right_model: 'model.size',
          right_column: 'group_code',
        },
      ],
    }
    const visible = new Set(['model.sku', 'model.size', 'model.fact'])
    const map = connectedEndpointJoinKeyHighlights(joinKeys, visible)
    expect(map.get('model.sku')?.has('size_code')).toBe(true)
    expect(map.get('model.sku')?.has('group_code')).toBe(true)
    expect(map.get('model.size')?.has('size_code')).toBe(true)
    expect(map.get('model.size')?.has('group_code')).toBe(true)
  })

  it('uses the same color for dual keys on the same parent pair', () => {
    const joinKeys: JoinKeysData = {
      'model.fact': [
        {
          left_model: 'model.sku',
          left_column: 'size_code',
          right_model: 'model.size',
          right_column: 'size_code',
        },
        {
          left_model: 'model.sku',
          left_column: 'group_code',
          right_model: 'model.size',
          right_column: 'group_code',
        },
      ],
    }
    const map = connectedEndpointJoinKeyHighlights(
      joinKeys,
      new Set(['model.sku', 'model.size']),
    )
    const sizeColor = map.get('model.sku')?.get('size_code')
    const groupColor = map.get('model.sku')?.get('group_code')
    expect(sizeColor).toBeTruthy()
    expect(groupColor).toBe(sizeColor)
    expect(map.get('model.size')?.get('size_code')).toBe(sizeColor)
    expect(map.get('model.size')?.get('group_code')).toBe(sizeColor)
  })

  it('uses different colors for distinct parent-pair relationships', () => {
    const joinKeys: JoinKeysData = {
      'model.order_items': [
        {
          left_model: 'model.stg_order_items',
          left_column: 'order_id',
          right_model: 'model.stg_orders',
          right_column: 'order_id',
        },
        {
          left_model: 'model.stg_order_items',
          left_column: 'product_id',
          right_model: 'model.stg_products',
          right_column: 'product_id',
        },
      ],
    }
    const map = connectedEndpointJoinKeyHighlights(
      joinKeys,
      new Set(['model.stg_order_items', 'model.stg_orders', 'model.stg_products']),
    )
    const orderColor = map.get('model.stg_order_items')?.get('order_id')
    const productColor = map.get('model.stg_order_items')?.get('product_id')
    expect(orderColor).toBeTruthy()
    expect(productColor).toBeTruthy()
    expect(orderColor).not.toBe(productColor)
    expect(map.get('model.stg_orders')?.get('order_id')).toBe(orderColor)
    expect(map.get('model.stg_products')?.get('product_id')).toBe(productColor)
  })

  it('skips pairs when an endpoint is outside the current subgraph', () => {
    const joinKeys: JoinKeysData = {
      'model.fact': [
        {
          left_model: 'model.sku',
          left_column: 'size_code',
          right_model: 'model.size',
          right_column: 'size_code',
        },
      ],
    }
    const map = connectedEndpointJoinKeyHighlights(joinKeys, new Set(['model.sku', 'model.fact']))
    expect(map.size).toBe(0)
  })

  it('highlights parent→child join keys when both are visible', () => {
    const joinKeys: JoinKeysData = {
      'model.order_items': [
        {
          left_model: 'model.order_items',
          left_column: 'order_id',
          right_model: 'model.orders',
          right_column: 'order_id',
        },
      ],
    }
    const map = connectedEndpointJoinKeyHighlights(
      joinKeys,
      new Set(['model.order_items', 'model.orders']),
    )
    expect(map.get('model.order_items')?.has('order_id')).toBe(true)
    expect(map.get('model.orders')?.has('order_id')).toBe(true)
  })
})

describe('formatJoinPredicate', () => {
  it('prefers qualified model.column form when available', () => {
    const text = formatJoinPredicate(
      {
        source_column: 'id',
        target_column: 'user_id',
        left_model: 'model.a',
        left_column: 'id',
        right_model: 'model.b',
        right_column: 'user_id',
      },
      id => (id === 'model.a' ? 'users' : 'orders'),
    )
    expect(text).toBe('users.id = orders.user_id')
  })
})

describe('formatJoinTypeBadge', () => {
  it('normalizes common join types', () => {
    expect(formatJoinTypeBadge('left')).toBe('LEFT')
    expect(formatJoinTypeBadge('INNER')).toBe('INNER')
    expect(formatJoinTypeBadge(undefined)).toBeNull()
  })
})

describe('joinedParentBadgesForFocus', () => {
  it('badges non-base parents with join type for the focused model', () => {
    const joinKeys: JoinKeysData = {
      'model.order_items': [
        {
          left_model: 'model.stg_order_items',
          left_column: 'order_id',
          right_model: 'model.stg_orders',
          right_column: 'order_id',
          join_type: 'left',
        },
        {
          left_model: 'model.stg_order_items',
          left_column: 'product_id',
          right_model: 'model.stg_products',
          right_column: 'product_id',
          join_type: 'left',
        },
      ],
    }
    const bases = { 'model.order_items': 'model.stg_order_items' }
    const map = joinedParentBadgesForFocus(joinKeys, bases, new Set(['model.order_items']))
    expect(map.get('model.stg_orders')).toBe('LEFT')
    expect(map.get('model.stg_products')).toBe('LEFT')
    expect(map.has('model.stg_order_items')).toBe(false)
  })
})
