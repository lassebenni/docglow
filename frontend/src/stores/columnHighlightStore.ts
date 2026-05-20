import { create } from 'zustand'

interface ColumnSelection {
  modelId: string
  columnName: string
}

interface ColumnHighlightState {
  selectedColumn: ColumnSelection | null
  expandedNodeIds: Set<string>
  autoExpandedNodeIds: Set<string>
  manuallyCollapsedIds: Set<string>
  selectColumn: (modelId: string, columnName: string) => void
  clearSelection: () => void
  toggleNodeExpanded: (nodeId: string) => void
  setAutoExpandedNodes: (nodeIds: Set<string>) => void
  isNodeExpanded: (nodeId: string) => boolean
  expandAll: (candidateIds: string[], cap: number) => { expanded: number; total: number }
  collapseAll: (candidateIds: string[]) => void
  resetExpandState: () => void
}

export const useColumnHighlightStore = create<ColumnHighlightState>((set, get) => ({
  selectedColumn: null,
  expandedNodeIds: new Set(),
  autoExpandedNodeIds: new Set(),
  manuallyCollapsedIds: new Set(),

  selectColumn: (modelId, columnName) => {
    const current = get().selectedColumn
    if (current?.modelId === modelId && current?.columnName === columnName) {
      set({ selectedColumn: null })
    } else {
      set({ selectedColumn: { modelId, columnName } })
    }
  },

  clearSelection: () => {
    set({ selectedColumn: null })
  },

  toggleNodeExpanded: (nodeId) => {
    const { expandedNodeIds, autoExpandedNodeIds, manuallyCollapsedIds, selectedColumn } = get()

    // If this node was auto-expanded and not manually collapsed, collapse it
    if (autoExpandedNodeIds.has(nodeId) && !manuallyCollapsedIds.has(nodeId)) {
      const nextCollapsed = new Set(manuallyCollapsedIds)
      nextCollapsed.add(nodeId)
      if (selectedColumn?.modelId === nodeId) {
        set({ manuallyCollapsedIds: nextCollapsed, selectedColumn: null })
      } else {
        set({ manuallyCollapsedIds: nextCollapsed })
      }
      return
    }

    // If this node was manually collapsed after auto-expand, re-expand it
    if (autoExpandedNodeIds.has(nodeId) && manuallyCollapsedIds.has(nodeId)) {
      const nextCollapsed = new Set(manuallyCollapsedIds)
      nextCollapsed.delete(nodeId)
      set({ manuallyCollapsedIds: nextCollapsed })
      return
    }

    // Normal manual toggle
    const next = new Set(expandedNodeIds)
    if (next.has(nodeId)) {
      next.delete(nodeId)
      if (selectedColumn?.modelId === nodeId) {
        set({ expandedNodeIds: next, selectedColumn: null })
        return
      }
    } else {
      next.add(nodeId)
    }
    set({ expandedNodeIds: next })
  },

  setAutoExpandedNodes: (nodeIds) => {
    set({ autoExpandedNodeIds: nodeIds, manuallyCollapsedIds: new Set() })
  },

  isNodeExpanded: (nodeId) => {
    const { expandedNodeIds, autoExpandedNodeIds, manuallyCollapsedIds } = get()
    if (expandedNodeIds.has(nodeId)) return true
    if (autoExpandedNodeIds.has(nodeId) && !manuallyCollapsedIds.has(nodeId)) return true
    return false
  },

  // Expand the first `cap` candidates by sorted unique_id. Any candidates beyond
  // the cap go into manuallyCollapsedIds so the local auto-expand memo in
  // LineageFlow does not still display their columns. Returns the actual counts
  // so the UI can render the over-cap message.
  expandAll: (candidateIds, cap) => {
    const total = candidateIds.length
    const sliceSize = Math.max(0, Math.min(cap, total))
    const sorted = [...candidateIds].sort()
    const expanded = sorted.slice(0, sliceSize)
    const suppressed = sorted.slice(sliceSize)
    set({
      expandedNodeIds: new Set(expanded),
      autoExpandedNodeIds: new Set(),
      manuallyCollapsedIds: new Set(suppressed),
    })
    return { expanded: sliceSize, total }
  },

  // Hide every candidate's columns, including any auto-expanded by the local
  // memo in LineageFlow. Populating manuallyCollapsedIds with the full
  // candidate set is the override mechanism that defeats auto-expand.
  collapseAll: (candidateIds) => {
    set({
      expandedNodeIds: new Set(),
      autoExpandedNodeIds: new Set(),
      manuallyCollapsedIds: new Set(candidateIds),
    })
  },

  // Wipes all expand-related state. Called on LineageFlow mount so per-page
  // expand/collapse is ephemeral — returning to a page restarts auto-expand
  // fresh rather than carrying stale ids from a previous view.
  resetExpandState: () => {
    set({
      expandedNodeIds: new Set(),
      autoExpandedNodeIds: new Set(),
      manuallyCollapsedIds: new Set(),
    })
  },
}))
