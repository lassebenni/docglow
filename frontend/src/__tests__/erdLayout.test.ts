import { describe, it, expect } from 'vitest'
import { computeErdLayout, TABLE_W } from '../utils/erdLayout'

const H = 200

const node = (uid: string, height = H) => ({ uid, height })
const edge = (from: string, to: string) => ({ from, to })

/** Two axis-aligned boxes at top-left {x,y} of size (w, h) overlap iff
 *  their open intervals intersect on both axes. Used to assert dagre's
 *  output never produces overlapping nodes. */
function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}

describe('computeErdLayout (dagre)', () => {
  it('returns empty object for empty input', () => {
    expect(computeErdLayout([], [])).toEqual({})
  })

  it('places a single node at a finite position', () => {
    const result = computeErdLayout([node('m.a')], [])
    expect(result['m.a']).toBeDefined()
    expect(Number.isFinite(result['m.a'].x)).toBe(true)
    expect(Number.isFinite(result['m.a'].y)).toBe(true)
  })

  it('produces non-overlapping rectangles for connected nodes', () => {
    const nodes = [
      node('m.orders'),
      node('m.customers'),
      node('m.items'),
      node('m.products'),
    ]
    const edges = [
      edge('m.orders', 'm.customers'),
      edge('m.items', 'm.orders'),
      edge('m.items', 'm.products'),
    ]
    const result = computeErdLayout(nodes, edges)

    const rects = nodes.map((n) => ({
      uid: n.uid,
      x: result[n.uid].x,
      y: result[n.uid].y,
      w: TABLE_W,
      h: n.height,
    }))

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false)
      }
    }
  })

  it('respects per-node heights — taller nodes do not collide with neighbors', () => {
    // A wide range of heights — the v1 grid would have overlapped these.
    const nodes = [
      node('m.tall', 400),
      node('m.short', 80),
      node('m.medium', 200),
      node('m.alsoTall', 350),
      node('m.alsoShort', 90),
    ]
    const edges = [
      edge('m.tall', 'm.short'),
      edge('m.medium', 'm.short'),
      edge('m.alsoTall', 'm.medium'),
      edge('m.alsoShort', 'm.alsoTall'),
    ]
    const result = computeErdLayout(nodes, edges)

    const rects = nodes.map((n) => ({
      x: result[n.uid].x,
      y: result[n.uid].y,
      w: TABLE_W,
      h: n.height,
    }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false)
      }
    }
  })

  it('lays out disconnected nodes (orphan layer) without overlapping', () => {
    const nodes = [node('m.a'), node('m.b'), node('m.c')]
    const result = computeErdLayout(nodes, [])
    const rects = nodes.map((n) => ({
      x: result[n.uid].x,
      y: result[n.uid].y,
      w: TABLE_W,
      h: n.height,
    }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i], rects[j])).toBe(false)
      }
    }
  })

  it('places child to the left of parent (LR rankdir, child→parent edges)', () => {
    // Convention: ERD edges point child → parent (FK → PK). With rankdir=LR,
    // children land in earlier ranks (lower x) than their parents.
    const result = computeErdLayout(
      [node('m.child'), node('m.parent')],
      [edge('m.child', 'm.parent')],
    )
    expect(result['m.child'].x).toBeLessThan(result['m.parent'].x)
  })

  it('drops self-loops without throwing', () => {
    const result = computeErdLayout(
      [node('m.self')],
      [edge('m.self', 'm.self')],
    )
    expect(result['m.self']).toBeDefined()
  })

  it('drops edges referencing missing uids', () => {
    const result = computeErdLayout(
      [node('m.a')],
      [edge('m.a', 'm.ghost'), edge('m.ghost', 'm.a')],
    )
    expect(result['m.a']).toBeDefined()
    expect(result['m.ghost']).toBeUndefined()
  })

  it('deduplicates parallel edges between the same pair', () => {
    // Two relationships between (a, b) shouldn't warp the layout vs one.
    const a = computeErdLayout(
      [node('m.a'), node('m.b')],
      [edge('m.a', 'm.b')],
    )
    const b = computeErdLayout(
      [node('m.a'), node('m.b')],
      [edge('m.a', 'm.b'), edge('m.a', 'm.b'), edge('m.a', 'm.b')],
    )
    expect(a).toEqual(b)
  })

  it('is deterministic — same input yields identical output across calls', () => {
    const nodes = [node('m.x'), node('m.y'), node('m.z'), node('m.w')]
    const edges = [edge('m.x', 'm.y'), edge('m.z', 'm.w'), edge('m.y', 'm.w')]
    const a = computeErdLayout(nodes, edges)
    const b = computeErdLayout(nodes, edges)
    expect(a).toEqual(b)
  })

  it('does not mutate input arrays', () => {
    const nodes = [node('m.b'), node('m.a')]
    const edges = [edge('m.a', 'm.b')]
    const nodesBefore = nodes.map((n) => ({ ...n }))
    const edgesBefore = edges.map((e) => ({ ...e }))
    computeErdLayout(nodes, edges)
    expect(nodes).toEqual(nodesBefore)
    expect(edges).toEqual(edgesBefore)
  })
})
