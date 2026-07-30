import type { JoinKeyPair, JoinKeysData, LineageEdge } from '../types'

export interface EdgeJoinKey {
  readonly source_column: string
  readonly target_column: string
  /** Optional qualified labels for the side panel */
  readonly left_model?: string
  readonly left_column?: string
  readonly right_model?: string
  readonly right_column?: string
  readonly join_type?: string
}

/**
 * Collect join-key pairs that apply to a table edge between sourceId → targetId.
 * Unions edge-embedded keys with pairs from join_keys maps whose endpoints match.
 */
export function getJoinKeysForEdge(
  sourceId: string,
  targetId: string,
  edge: LineageEdge | undefined,
  joinKeysByModel: JoinKeysData | null | undefined,
): EdgeJoinKey[] {
  const seen = new Set<string>()
  const out: EdgeJoinKey[] = []

  const push = (key: EdgeJoinKey) => {
    const marker = `${key.source_column}\0${key.target_column}`
    if (seen.has(marker)) return
    seen.add(marker)
    out.push(key)
  }

  if (edge?.join_keys) {
    for (const jk of edge.join_keys) {
      push({
        source_column: jk.source_column,
        target_column: jk.target_column,
      })
    }
  }

  if (joinKeysByModel) {
    for (const pairs of Object.values(joinKeysByModel)) {
      for (const pair of pairs) {
        const oriented = orientPair(pair, sourceId, targetId)
        if (oriented) push(oriented)
      }
    }
  }

  return out
}

function orientPair(
  pair: JoinKeyPair,
  sourceId: string,
  targetId: string,
): EdgeJoinKey | null {
  if (pair.left_model === sourceId && pair.right_model === targetId) {
    return {
      source_column: pair.left_column,
      target_column: pair.right_column,
      left_model: pair.left_model,
      left_column: pair.left_column,
      right_model: pair.right_model,
      right_column: pair.right_column,
      join_type: pair.join_type,
    }
  }
  if (pair.right_model === sourceId && pair.left_model === targetId) {
    return {
      source_column: pair.right_column,
      target_column: pair.left_column,
      left_model: pair.left_model,
      left_column: pair.left_column,
      right_model: pair.right_model,
      right_column: pair.right_column,
      join_type: pair.join_type,
    }
  }
  return null
}

/** Build per-node highlighted column sets for a selected edge's join keys. */
export function joinKeyHighlightSets(
  pairs: EdgeJoinKey[],
  sourceId: string,
  targetId: string,
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const ensure = (id: string) => {
    let set = map.get(id)
    if (!set) {
      set = new Set()
      map.set(id, set)
    }
    return set
  }
  for (const p of pairs) {
    ensure(sourceId).add(p.source_column)
    ensure(targetId).add(p.target_column)
  }
  return map
}

/**
 * Colorblind-friendly palette for ambient join-key highlights.
 * One color per parent-pair relationship (dual keys share a color).
 */
export const JOIN_KEY_PALETTE = [
  '#0d9488', // teal
  '#2563eb', // blue
  '#c2410c', // rust
  '#15803d', // green
  '#be123c', // rose
  '#a16207', // olive
] as const

/** Stable key for an unordered pair of model unique_ids. */
export function joinRelationshipKey(leftModel: string, rightModel: string): string {
  return leftModel < rightModel
    ? `${leftModel}\0${rightModel}`
    : `${rightModel}\0${leftModel}`
}

/**
 * Model Lineage tab v1: highlight join-key columns only on currently connected
 * endpoints — both sides of a join pair must be in the visible subgraph.
 *
 * Returns ``Map<nodeId, Map<column, color>>``. Columns that belong to the same
 * parent-pair relationship share a color; distinct relationships get distinct
 * palette entries (cycled). If a column participates in multiple relationships,
 * the first assigned color wins.
 *
 * Covers parent→child edges and sibling dual-key parents (no depends_on edge
 * between them) when both parents are visible. Does not walk all upstream
 * outside the current depth window (that is a later enhancement).
 */
export function connectedEndpointJoinKeyHighlights(
  joinKeysByModel: JoinKeysData | null | undefined,
  visibleNodeIds: ReadonlySet<string>,
): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>()
  if (!joinKeysByModel) return map

  const relationshipColor = new Map<string, string>()
  let nextColor = 0

  const colorForRelationship = (leftModel: string, rightModel: string): string => {
    const key = joinRelationshipKey(leftModel, rightModel)
    let color = relationshipColor.get(key)
    if (!color) {
      color = JOIN_KEY_PALETTE[nextColor % JOIN_KEY_PALETTE.length]!
      nextColor += 1
      relationshipColor.set(key, color)
    }
    return color
  }

  const setColumnColor = (modelId: string, column: string, color: string) => {
    let cols = map.get(modelId)
    if (!cols) {
      cols = new Map()
      map.set(modelId, cols)
    }
    if (!cols.has(column)) cols.set(column, color)
  }

  for (const pairs of Object.values(joinKeysByModel)) {
    for (const pair of pairs) {
      if (!visibleNodeIds.has(pair.left_model) || !visibleNodeIds.has(pair.right_model)) {
        continue
      }
      const color = colorForRelationship(pair.left_model, pair.right_model)
      setColumnColor(pair.left_model, pair.left_column, color)
      setColumnColor(pair.right_model, pair.right_column, color)
    }
  }
  return map
}

/** Compact badge label for a SQL JOIN side/kind (e.g. ``left`` → ``LEFT``). */
export function formatJoinTypeBadge(joinType: string | null | undefined): string | null {
  if (!joinType) return null
  const normalized = joinType.trim().toLowerCase()
  if (!normalized || normalized === 'inner') return 'INNER'
  if (normalized === 'left' || normalized === 'right' || normalized === 'full' || normalized === 'cross') {
    return normalized.toUpperCase()
  }
  // Unknown kinds (e.g. semi/anti) — still surface a short uppercase token.
  return normalized.replace(/\s+/g, '-').toUpperCase().slice(0, 8)
}

/**
 * For focused models, map non-base join endpoints → compact join-type badge.
 *
 * Uses each focus model's join_keys pairs and join_bases entry. The Base
 * (FROM) parent never gets a type badge; only the other side(s) of each pair.
 * First assigned type wins if a node appears in multiple joins.
 */
export function joinedParentBadgesForFocus(
  joinKeysByModel: JoinKeysData | null | undefined,
  joinBasesByModel: Record<string, string> | null | undefined,
  focusModelIds: ReadonlySet<string>,
): Map<string, string> {
  const map = new Map<string, string>()
  if (!joinKeysByModel || focusModelIds.size === 0) return map

  for (const focusId of focusModelIds) {
    const pairs = joinKeysByModel[focusId]
    if (!pairs || pairs.length === 0) continue
    const baseId = joinBasesByModel?.[focusId] ?? null

    for (const pair of pairs) {
      const badge = formatJoinTypeBadge(pair.join_type)
      if (!badge) continue

      for (const endpoint of [pair.left_model, pair.right_model]) {
        if (baseId && endpoint === baseId) continue
        if (!map.has(endpoint)) map.set(endpoint, badge)
      }
    }
  }
  return map
}

export type JoinIndirectData = Record<string, ReadonlyArray<{ readonly model: string; readonly kind: string }>>

/**
 * Badge parents that contribute only via joined aggregate / intermediate CTEs.
 * Does not overwrite Base or direct JOIN-type badges.
 */
export function indirectParentBadgesForFocus(
  joinIndirectByModel: JoinIndirectData | null | undefined,
  joinBasesByModel: Record<string, string> | null | undefined,
  existingBadges: ReadonlyMap<string, string>,
  focusModelIds: ReadonlySet<string>,
): Map<string, string> {
  const map = new Map<string, string>()
  if (!joinIndirectByModel || focusModelIds.size === 0) return map

  for (const focusId of focusModelIds) {
    const parents = joinIndirectByModel[focusId]
    if (!parents) continue
    const baseId = joinBasesByModel?.[focusId] ?? null
    for (const parent of parents) {
      if (!parent.model || parent.model === baseId) continue
      if (existingBadges.has(parent.model) || map.has(parent.model)) continue
      const kind = (parent.kind || 'cte').toLowerCase()
      map.set(parent.model, kind === 'agg' ? 'AGG' : 'CTE')
    }
  }
  return map
}

export function joinRoleBadgeTitle(badge: string): string {
  switch (badge) {
    case 'LEFT':
    case 'RIGHT':
    case 'FULL':
    case 'INNER':
    case 'CROSS':
      return `${badge} JOIN into the focused model's FROM parent`
    case 'AGG':
      return 'Contributes via an aggregate CTE — not the FROM base and not a direct JOIN endpoint'
    case 'CTE':
      return 'Contributes via an intermediate CTE — not the FROM base and not a direct JOIN endpoint'
    default:
      return `Join role: ${badge}`
  }
}

export function formatJoinPredicate(
  pair: EdgeJoinKey,
  nameOf: (modelId: string) => string,
): string {
  if (pair.left_model && pair.right_model && pair.left_column && pair.right_column) {
    return `${nameOf(pair.left_model)}.${pair.left_column} = ${nameOf(pair.right_model)}.${pair.right_column}`
  }
  return `${pair.source_column} = ${pair.target_column}`
}
