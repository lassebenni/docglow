import { useMemo } from 'react'
import type { JoinKeysData, LineageEdge, LineageNode } from '../../types'
import {
  connectedEndpointJoinKeyHighlights,
  getJoinKeysForEdge,
  indirectParentBadgesForFocus,
  joinKeyHighlightSets,
  joinedParentBadgesForFocus,
  type EdgeJoinKey,
  type JoinIndirectData,
} from '../../utils/joinKeys'

export interface SelectedEdgeJoin {
  sourceId: string
  targetId: string
  pairs: EdgeJoinKey[]
  highlights: Map<string, Set<string>>
}

/**
 * Join-highlight + badge state derived from the top-level join_keys payload.
 * Keeps LineageFlow composition thinner by owning join UX memos in one place.
 */
export function useJoinHighlights(args: {
  selectedEdgeId: string | null
  edges: readonly LineageEdge[]
  nodes: readonly LineageNode[]
  joinKeysData?: JoinKeysData | null
  joinBasesData?: Record<string, string> | null
  joinIndirectData?: JoinIndirectData | null
  pinnedIds?: ReadonlySet<string> | null
  effectiveExpandedIds: ReadonlySet<string>
}): {
  selectedEdgeJoin: SelectedEdgeJoin | null
  connectedJoinHighlights: Map<string, Map<string, string>> | null
  joinBaseNodeIds: Set<string>
  joinTypeBadges: Map<string, string>
} {
  const {
    selectedEdgeId,
    edges,
    nodes,
    joinKeysData,
    joinBasesData,
    joinIndirectData,
    pinnedIds,
    effectiveExpandedIds,
  } = args

  const selectedEdgeJoin = useMemo((): SelectedEdgeJoin | null => {
    if (!selectedEdgeId || selectedEdgeId.startsWith('col__')) return null
    const sep = selectedEdgeId.indexOf('__')
    if (sep < 0) return null
    const sourceId = selectedEdgeId.slice(0, sep)
    const targetId = selectedEdgeId.slice(sep + 2)
    const edge = edges.find(e => e.source === sourceId && e.target === targetId)
    const pairs = getJoinKeysForEdge(sourceId, targetId, edge, joinKeysData)
    if (pairs.length === 0) return null
    return {
      sourceId,
      targetId,
      pairs,
      highlights: joinKeyHighlightSets(pairs, sourceId, targetId),
    }
  }, [selectedEdgeId, edges, joinKeysData])

  const connectedJoinHighlights = useMemo(() => {
    if (selectedEdgeJoin) return null
    if (effectiveExpandedIds.size === 0) return null
    const visible = new Set(nodes.map(n => n.id))
    const map = connectedEndpointJoinKeyHighlights(joinKeysData, visible)
    return map.size > 0 ? map : null
  }, [selectedEdgeJoin, nodes, effectiveExpandedIds, joinKeysData])

  const joinBaseNodeIds = useMemo(() => {
    const ids = new Set<string>()
    if (!joinBasesData || !pinnedIds || pinnedIds.size === 0) return ids
    for (const focusId of pinnedIds) {
      const base = joinBasesData[focusId]
      if (base) ids.add(base)
    }
    return ids
  }, [joinBasesData, pinnedIds])

  const joinTypeBadges = useMemo(() => {
    if (!pinnedIds || pinnedIds.size === 0) return new Map<string, string>()
    const direct = joinedParentBadgesForFocus(joinKeysData, joinBasesData, pinnedIds)
    const indirect = indirectParentBadgesForFocus(
      joinIndirectData,
      joinBasesData,
      direct,
      pinnedIds,
    )
    const merged = new Map(direct)
    for (const [id, badge] of indirect) merged.set(id, badge)
    return merged
  }, [joinKeysData, joinBasesData, joinIndirectData, pinnedIds])

  return {
    selectedEdgeJoin,
    connectedJoinHighlights,
    joinBaseNodeIds,
    joinTypeBadges,
  }
}
