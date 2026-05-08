/**
 * erdSubgraph — pure helpers for slicing the global ERD relationships graph
 * down to model-scoped subgraphs.
 *
 * U5 (DOC-221): `getModelErdSubgraph` returns the 1-hop subgraph involving
 * a focal model — every relationship where the focal model is either the
 * `from_unique_id` or the `to_unique_id`, plus the model uids on the other
 * side of those edges.
 *
 * Ghost relationships (`parent_column_exists === false` or `to_unique_id`
 * empty) are intentionally INCLUDED — the inspector handles their rendering
 * and the canvas filters them at edge-build time. Mirrors `ErdCanvas`.
 *
 * Self-referential relationships (from === to === focal) appear once.
 *
 * Models with zero matching relationships return `{ models: Set(), relationships: [] }`
 * — the caller decides whether to render an empty-state UI.
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
