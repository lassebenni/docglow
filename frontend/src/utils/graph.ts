import type { LineageEdge, LineageNode } from '../types'

export function getUpstream(
  nodeId: string,
  edges: LineageEdge[],
  depth: number = 2,
): Set<string> {
  const result = new Set<string>()
  let current = new Set([nodeId])

  for (let i = 0; i < depth; i++) {
    const next = new Set<string>()
    for (const edge of edges) {
      if (current.has(edge.target) && !result.has(edge.source)) {
        next.add(edge.source)
        result.add(edge.source)
      }
    }
    if (next.size === 0) break
    current = next
  }

  return result
}

export function getDownstream(
  nodeId: string,
  edges: LineageEdge[],
  depth: number = 2,
): Set<string> {
  const result = new Set<string>()
  let current = new Set([nodeId])

  for (let i = 0; i < depth; i++) {
    const next = new Set<string>()
    for (const edge of edges) {
      if (current.has(edge.source) && !result.has(edge.target)) {
        next.add(edge.target)
        result.add(edge.target)
      }
    }
    if (next.size === 0) break
    current = next
  }

  return result
}

/** Return the node and every downstream descendant reachable via DFS on `edges`. */
export function getDescendants(nodeId: string, edges: LineageEdge[]): Set<string> {
  const result = new Set<string>([nodeId])
  const childMap = new Map<string, string[]>()
  for (const e of edges) {
    const list = childMap.get(e.source)
    if (list) list.push(e.target)
    else childMap.set(e.source, [e.target])
  }
  const stack = [nodeId]
  while (stack.length) {
    const current = stack.pop()!
    for (const child of childMap.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child)
        stack.push(child)
      }
    }
  }
  return result
}

export type LineageDirection = 'both' | 'upstream' | 'downstream'

/**
 * Focal-paths subgraph: keep only edges that lie on a direct upstream or
 * downstream BFS path from `nodeId`. Sideways edges between siblings and
 * "bypass" edges (e.g. A→C alongside A→B→C) are dropped so the focal
 * model's true parent and child chains stay readable in dense graphs.
 *
 * Algorithm: BFS once upstream and once downstream from the focal, recording
 * each visited node's distance. An edge is monotonic-upstream if its source
 * is exactly one layer further from the focal than its target along the
 * upstream tree (`uD[src] === uD[tgt] + 1`); analogous for downstream.
 */
export function getSubgraph(
  nodeId: string,
  nodes: LineageNode[],
  edges: LineageEdge[],
  depth: number = 2,
  direction: LineageDirection = 'both',
  parentsDepth: number = depth,
  childrenDepth: number = depth,
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const upstreamDist: Record<string, number> = { [nodeId]: 0 }
  let frontier = new Set([nodeId])
  for (let d = 1; d <= parentsDepth; d++) {
    const next = new Set<string>()
    for (const edge of edges) {
      if (frontier.has(edge.target) && upstreamDist[edge.source] === undefined) {
        upstreamDist[edge.source] = d
        next.add(edge.source)
      }
    }
    if (next.size === 0) break
    frontier = next
  }

  const downstreamDist: Record<string, number> = { [nodeId]: 0 }
  frontier = new Set([nodeId])
  for (let d = 1; d <= childrenDepth; d++) {
    const next = new Set<string>()
    for (const edge of edges) {
      if (frontier.has(edge.source) && downstreamDist[edge.target] === undefined) {
        downstreamDist[edge.target] = d
        next.add(edge.target)
      }
    }
    if (next.size === 0) break
    frontier = next
  }

  const keep = new Set<string>([nodeId])
  if (direction !== 'downstream') for (const k of Object.keys(upstreamDist)) keep.add(k)
  if (direction !== 'upstream') for (const k of Object.keys(downstreamDist)) keep.add(k)

  const upstreamMonotonic = (src: string, tgt: string) =>
    upstreamDist[src] !== undefined &&
    upstreamDist[tgt] !== undefined &&
    upstreamDist[src] === upstreamDist[tgt] + 1
  const downstreamMonotonic = (src: string, tgt: string) =>
    downstreamDist[src] !== undefined &&
    downstreamDist[tgt] !== undefined &&
    downstreamDist[tgt] === downstreamDist[src] + 1

  const filteredEdges: LineageEdge[] = []
  for (const edge of edges) {
    if (!keep.has(edge.source) || !keep.has(edge.target)) continue
    if (direction === 'upstream') {
      if (upstreamMonotonic(edge.source, edge.target)) filteredEdges.push(edge)
    } else if (direction === 'downstream') {
      if (downstreamMonotonic(edge.source, edge.target)) filteredEdges.push(edge)
    } else if (
      upstreamMonotonic(edge.source, edge.target) ||
      downstreamMonotonic(edge.source, edge.target)
    ) {
      filteredEdges.push(edge)
    }
  }

  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: filteredEdges,
  }
}

/** Compute the union of subgraphs for multiple pinned nodes. */
export function getUnionSubgraph(
  nodeIds: string[],
  nodes: LineageNode[],
  edges: LineageEdge[],
  depth: number = 2,
  direction: LineageDirection = 'both',
  parentsDepth: number = depth,
  childrenDepth: number = depth,
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  if (nodeIds.length === 0) return { nodes: [], edges: [] }
  if (nodeIds.length === 1)
    return getSubgraph(nodeIds[0], nodes, edges, depth, direction, parentsDepth, childrenDepth)

  const relevantIds = new Set<string>()
  for (const nodeId of nodeIds) {
    relevantIds.add(nodeId)
    const upstream =
      direction !== 'downstream' ? getUpstream(nodeId, edges, parentsDepth) : new Set<string>()
    const downstream =
      direction !== 'upstream' ? getDownstream(nodeId, edges, childrenDepth) : new Set<string>()
    for (const id of upstream) relevantIds.add(id)
    for (const id of downstream) relevantIds.add(id)
  }

  return {
    nodes: nodes.filter((n) => relevantIds.has(n.id)),
    edges: edges.filter((e) => relevantIds.has(e.source) && relevantIds.has(e.target)),
  }
}
