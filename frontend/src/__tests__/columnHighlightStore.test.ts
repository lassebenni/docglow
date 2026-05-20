// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useColumnHighlightStore } from '../stores/columnHighlightStore'

describe('columnHighlightStore', () => {
  beforeEach(() => {
    useColumnHighlightStore.setState({
      selectedColumn: null,
      expandedNodeIds: new Set(),
      autoExpandedNodeIds: new Set(),
      manuallyCollapsedIds: new Set(),
    })
  })

  describe('expandAll', () => {
    it('expands all candidate ids when count is under the cap', () => {
      const result = useColumnHighlightStore.getState().expandAll(['a', 'b', 'c'], 50)

      expect(result).toEqual({ expanded: 3, total: 3 })
      const { expandedNodeIds } = useColumnHighlightStore.getState()
      expect(expandedNodeIds.has('a')).toBe(true)
      expect(expandedNodeIds.has('b')).toBe(true)
      expect(expandedNodeIds.has('c')).toBe(true)
      expect(expandedNodeIds.size).toBe(3)
    })

    it('sorts candidate ids ascending before applying the cap', () => {
      // Construct an unsorted input — only the first 2 after sorting should land in the set.
      useColumnHighlightStore.getState().expandAll(['z', 'a', 'm'], 2)

      const { expandedNodeIds } = useColumnHighlightStore.getState()
      expect(expandedNodeIds.has('a')).toBe(true)
      expect(expandedNodeIds.has('m')).toBe(true)
      expect(expandedNodeIds.has('z')).toBe(false)
      expect(expandedNodeIds.size).toBe(2)
    })

    it('caps at the requested limit and reports total (covers AE1)', () => {
      const ids = Array.from({ length: 60 }, (_, i) => `n${String(i).padStart(3, '0')}`)
      const result = useColumnHighlightStore.getState().expandAll(ids, 50)

      expect(result).toEqual({ expanded: 50, total: 60 })
      const state = useColumnHighlightStore.getState()
      expect(state.expandedNodeIds.size).toBe(50)
      // The 10 candidates beyond the cap go into manuallyCollapsedIds so the
      // local auto-expand memo in LineageFlow does not still show their columns.
      expect(state.manuallyCollapsedIds.size).toBe(10)
      expect(state.manuallyCollapsedIds.has('n050')).toBe(true)
      expect(state.manuallyCollapsedIds.has('n059')).toBe(true)
    })

    it('handles an empty candidate list without throwing', () => {
      const result = useColumnHighlightStore.getState().expandAll([], 50)

      expect(result).toEqual({ expanded: 0, total: 0 })
      expect(useColumnHighlightStore.getState().expandedNodeIds.size).toBe(0)
    })

    it('handles cap = 0 as a degenerate but non-throwing input', () => {
      const result = useColumnHighlightStore.getState().expandAll(['a'], 0)

      expect(result).toEqual({ expanded: 0, total: 1 })
      expect(useColumnHighlightStore.getState().expandedNodeIds.size).toBe(0)
    })

    it('clears autoExpandedNodeIds and resets manuallyCollapsedIds when nothing is over-cap', () => {
      useColumnHighlightStore.setState({
        autoExpandedNodeIds: new Set(['x', 'y']),
        manuallyCollapsedIds: new Set(['y']),
      })

      useColumnHighlightStore.getState().expandAll(['a'], 50)

      const state = useColumnHighlightStore.getState()
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect(state.manuallyCollapsedIds.size).toBe(0) // no over-cap remainder → empty
      expect(state.expandedNodeIds.size).toBe(1)
      expect(state.expandedNodeIds.has('a')).toBe(true)
    })

    it('does not mutate selectedColumn', () => {
      useColumnHighlightStore.setState({
        selectedColumn: { modelId: 'model.x.y', columnName: 'id' },
      })

      useColumnHighlightStore.getState().expandAll(['a'], 50)

      expect(useColumnHighlightStore.getState().selectedColumn).toEqual({
        modelId: 'model.x.y',
        columnName: 'id',
      })
    })
  })

  describe('collapseAll', () => {
    it('marks every candidate as manually collapsed to override auto-expand (covers AE2)', () => {
      useColumnHighlightStore.setState({
        autoExpandedNodeIds: new Set(['a', 'b', 'c']),
        expandedNodeIds: new Set(['f', 'g']),
        manuallyCollapsedIds: new Set(['a']),
      })

      useColumnHighlightStore.getState().collapseAll(['a', 'b', 'c', 'd', 'e'])

      const state = useColumnHighlightStore.getState()
      expect(state.expandedNodeIds.size).toBe(0)
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect([...state.manuallyCollapsedIds].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('clears expanded and auto sets even when candidate list is empty', () => {
      useColumnHighlightStore.setState({
        expandedNodeIds: new Set(['x']),
        autoExpandedNodeIds: new Set(['y']),
      })

      useColumnHighlightStore.getState().collapseAll([])

      const state = useColumnHighlightStore.getState()
      expect(state.expandedNodeIds.size).toBe(0)
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect(state.manuallyCollapsedIds.size).toBe(0)
    })

    it('does not mutate selectedColumn', () => {
      useColumnHighlightStore.setState({
        selectedColumn: { modelId: 'model.x.y', columnName: 'id' },
        expandedNodeIds: new Set(['x']),
      })

      useColumnHighlightStore.getState().collapseAll(['x'])

      expect(useColumnHighlightStore.getState().selectedColumn).toEqual({
        modelId: 'model.x.y',
        columnName: 'id',
      })
    })
  })

  describe('resetExpandState', () => {
    it('clears expandedNodeIds populated by expandAll (covers AE3)', () => {
      useColumnHighlightStore.getState().expandAll(['a', 'b', 'c'], 50)
      expect(useColumnHighlightStore.getState().expandedNodeIds.size).toBe(3)

      useColumnHighlightStore.getState().resetExpandState()

      const state = useColumnHighlightStore.getState()
      expect(state.expandedNodeIds.size).toBe(0)
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect(state.manuallyCollapsedIds.size).toBe(0)
    })

    it('clears all three expansion sets regardless of source', () => {
      useColumnHighlightStore.setState({
        expandedNodeIds: new Set(['a']),
        autoExpandedNodeIds: new Set(['b']),
        manuallyCollapsedIds: new Set(['c']),
      })

      useColumnHighlightStore.getState().resetExpandState()

      const state = useColumnHighlightStore.getState()
      expect(state.expandedNodeIds.size).toBe(0)
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect(state.manuallyCollapsedIds.size).toBe(0)
    })

    it('does not touch selectedColumn', () => {
      useColumnHighlightStore.setState({
        selectedColumn: { modelId: 'model.x.y', columnName: 'id' },
        expandedNodeIds: new Set(['a']),
      })

      useColumnHighlightStore.getState().resetExpandState()

      expect(useColumnHighlightStore.getState().selectedColumn).toEqual({
        modelId: 'model.x.y',
        columnName: 'id',
      })
    })
  })

  describe('expandAll + collapseAll integration', () => {
    it('collapseAll then expandAll produces a clean expanded-only state', () => {
      useColumnHighlightStore.setState({
        autoExpandedNodeIds: new Set(['x']),
        expandedNodeIds: new Set(['y']),
      })

      useColumnHighlightStore.getState().collapseAll(['x', 'y'])
      useColumnHighlightStore.getState().expandAll(['a', 'b'], 50)

      const state = useColumnHighlightStore.getState()
      expect([...state.expandedNodeIds].sort()).toEqual(['a', 'b'])
      expect(state.autoExpandedNodeIds.size).toBe(0)
      expect(state.manuallyCollapsedIds.size).toBe(0)
    })
  })
})
