/**
 * erdSuggestions — pure helper that ranks models for the `/erd` landing
 * screen's "Suggested starting points" grid (U6 / DOC-222).
 *
 * Ranking: `relationships_count` descending, alphabetical (by `name`) tiebreak.
 *
 * Decision: ALL models are eligible — even those with `relationships_count === 0`
 * — because the user CAN focus a model with zero relationships and the
 * focused canvas confirms that explicitly. Models with no relationships
 * sort to the bottom by virtue of the count-descending sort. The caller
 * takes the top N (N = 12 on the landing page).
 */

import type { DocglowModel } from '../types'

export interface ErdSuggestion {
  readonly uniqueId: string
  readonly name: string
  readonly folder: string
  readonly relationshipsCount: number
}

const DEFAULT_TOP_N = 12

export function computeErdSuggestions(
  models: Readonly<Record<string, DocglowModel>>,
  topN: number = DEFAULT_TOP_N,
): ErdSuggestion[] {
  const all: ErdSuggestion[] = Object.entries(models).map(([uniqueId, model]) => ({
    uniqueId,
    name: model.name,
    folder: model.folder,
    relationshipsCount: model.relationships_count ?? 0,
  }))

  all.sort((a, b) => {
    if (b.relationshipsCount !== a.relationshipsCount) {
      return b.relationshipsCount - a.relationshipsCount
    }
    return a.name.localeCompare(b.name)
  })

  return all.slice(0, topN)
}
