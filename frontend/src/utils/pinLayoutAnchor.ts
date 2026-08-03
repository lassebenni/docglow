export interface LayoutAnchor {
  id: string
  x: number
  y: number
}

/**
 * Translate a layout so ``anchorId`` stays at its previous coordinates.
 *
 * Used in Field path only: switching columns on the same model reflows parents,
 * but the selected field's node should not jump in the roster.
 */
export function pinLayoutAnchor<T extends { id: string; x: number; y: number }>(
  nodes: readonly T[],
  anchorId: string | null | undefined,
  previous: LayoutAnchor | null,
): { nodes: T[]; anchor: LayoutAnchor | null } {
  if (!anchorId) return { nodes: [...nodes], anchor: null }

  const focus = nodes.find((n) => n.id === anchorId)
  if (!focus) return { nodes: [...nodes], anchor: null }

  if (previous && previous.id === anchorId) {
    const dx = previous.x - focus.x
    const dy = previous.y - focus.y
    if (dx !== 0 || dy !== 0) {
      const shifted = nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }))
      const pinned = shifted.find((n) => n.id === anchorId)!
      return {
        nodes: shifted,
        anchor: { id: anchorId, x: pinned.x, y: pinned.y },
      }
    }
  }

  return {
    nodes: [...nodes],
    anchor: { id: anchorId, x: focus.x, y: focus.y },
  }
}
