import { describe, it, expect } from 'vitest'
import { pinLayoutAnchor } from '../utils/pinLayoutAnchor'

describe('pinLayoutAnchor', () => {
  it('records the anchor on first layout', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'focus', x: 200, y: 100 },
    ]
    const { nodes: out, anchor } = pinLayoutAnchor(nodes, 'focus', null)
    expect(out).toEqual(nodes)
    expect(anchor).toEqual({ id: 'focus', x: 200, y: 100 })
  })

  it('translates the graph so the focus node keeps its prior position', () => {
    const previous = { id: 'focus', x: 200, y: 100 }
    const nodes = [
      { id: 'parent', x: 0, y: 50 },
      { id: 'focus', x: 180, y: 40 }, // dagre moved focus
    ]
    const { nodes: out, anchor } = pinLayoutAnchor(nodes, 'focus', previous)
    expect(out.find((n) => n.id === 'focus')).toEqual({ id: 'focus', x: 200, y: 100 })
    expect(out.find((n) => n.id === 'parent')).toEqual({ id: 'parent', x: 20, y: 110 })
    expect(anchor).toEqual(previous)
  })

  it('does not pin when the focus model changes', () => {
    const previous = { id: 'old', x: 200, y: 100 }
    const nodes = [
      { id: 'new', x: 50, y: 50 },
    ]
    const { nodes: out, anchor } = pinLayoutAnchor(nodes, 'new', previous)
    expect(out[0]).toEqual({ id: 'new', x: 50, y: 50 })
    expect(anchor).toEqual({ id: 'new', x: 50, y: 50 })
  })
})
