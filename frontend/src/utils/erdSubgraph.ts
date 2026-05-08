/**
 * erdSubgraph — pure helpers for slicing the global ERD relationships graph
 * down to model-scoped subgraphs.
 *
 * U5 (DOC-221): `getModelErdSubgraph` returns the 1-hop subgraph involving
 * a focal model — every relationship where the focal model is either the
 * `from_unique_id` or the `to_unique_id`, plus the model uids on the other
 * side of those edges.
 *
 * U6 (DOC-222): `getReachableErdSubgraph` returns the N-hop reachable
 * subgraph from a focal model, treating relationships as **undirected** for
 * BFS. The focused-canvas use case is "tables I can join with"; direction
 * is irrelevant for that question.
 *
 * Ghost relationships (`parent_column_exists === false` or `to_unique_id`
 * empty) are intentionally INCLUDED — the inspector handles their rendering
 * and the canvas filters them at edge-build time. Mirrors `ErdCanvas`.
 *
 * Self-referential relationships (from === to === focal) appear once.
 *
 * Models with zero matching relationships return:
 *   - `getModelErdSubgraph`: `{ models: Set(), relationships: [] }` (empty)
 *   - `getReachableErdSubgraph`: `{ models: Set([root]), relationships: [] }`
 *     (focal model always present so the caller can render it solo).
 */

import type { ErdRelationship } from '../types'

export interface ModelErdSubgraph {
  readonly models: Set<string>
  readonly relationships: ErdRelationship[]
}

/**
 * Compute the 1-hop ERD subgraph involving `modelId`.
 *
 * Filter: relationships where `from_unique_id === modelId || to_unique_id === modelId`.
 * Models: union of `from_unique_id` and `to_unique_id` across the filtered list
 * (so `modelId` itself is included whenever at least one match is present).
 *
 * Returns frozen-friendly arrays/sets — the caller must not mutate.
 */
export function getModelErdSubgraph(
  modelId: string,
  allRelationships: readonly ErdRelationship[],
): ModelErdSubgraph {
  const relationships: ErdRelationship[] = []
  const models = new Set<string>()

  for (const rel of allRelationships) {
    if (rel.from_unique_id === modelId || rel.to_unique_id === modelId) {
      relationships.push(rel)
      models.add(rel.from_unique_id)
      models.add(rel.to_unique_id)
    }
  }

  return { models, relationships }
}

/**
 * Compute the N-hop reachable ERD subgraph from `rootId`, treating each
 * relationship as a **bidirectional** edge for BFS purposes.
 *
 * Behavior:
 *   - `depth === 0` → just `rootId` in `models`, no relationships.
 *   - `rootId` not in any relationship → `{ models: Set([rootId]), relationships: [] }`
 *     (degrades gracefully — a stale URL or a model with zero relationships
 *     still produces a valid result that lets the caller render the focal
 *     model alone).
 *   - `depth >= max-reachable` → returns the full connected component
 *     containing `rootId`.
 *   - Self-referential relationship at root → included.
 *   - Disconnected components stay disconnected (no path → unreachable).
 *
 * Ghost relationships (`parent_column_exists === false`, `to_unique_id === ''`)
 * are passed through, matching `getModelErdSubgraph`. The canvas filters
 * them at edge-build time.
 *
 * Implementation: build an adjacency map keyed by both endpoints, then do a
 * level-by-level BFS up to `depth` hops. Track an edge-seen set so each
 * relationship appears at most once in the output even when both endpoints
 * are reached at the same level.
 */
export function getReachableErdSubgraph(
  rootId: string,
  allRelationships: readonly ErdRelationship[],
  depth: number,
): ModelErdSubgraph {
  const models = new Set<string>([rootId])
  const relationships: ErdRelationship[] = []
  const seenRelIds = new Set<string>()

  if (depth <= 0) {
    return { models, relationships }
  }

  // Build undirected adjacency: for each model uid, which relationships
  // touch it. We iterate the relationship list once, indexing by both
  // endpoints. Ghost relationships are kept; the caller decides what to do
  // with edges to the empty-string endpoint.
  const adjacency = new Map<string, ErdRelationship[]>()
  const push = (uid: string, rel: ErdRelationship): void => {
    const list = adjacency.get(uid)
    if (list) list.push(rel)
    else adjacency.set(uid, [rel])
  }
  for (const rel of allRelationships) {
    push(rel.from_unique_id, rel)
    if (rel.to_unique_id !== rel.from_unique_id) {
      push(rel.to_unique_id, rel)
    }
  }

  // Level-by-level BFS up to `depth` hops.
  let frontier = new Set<string>([rootId])
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>()
    for (const uid of frontier) {
      const incident = adjacency.get(uid)
      if (!incident) continue
      for (const rel of incident) {
        if (!seenRelIds.has(rel.id)) {
          seenRelIds.add(rel.id)
          relationships.push(rel)
        }
        // Other endpoint — for self-loops this is the same uid.
        const other =
          rel.from_unique_id === uid ? rel.to_unique_id : rel.from_unique_id
        if (!models.has(other)) {
          models.add(other)
          next.add(other)
        }
      }
    }
    if (next.size === 0) break
    frontier = next
  }

  return { models, relationships }
}
