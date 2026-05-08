// MUST come first — installs the localStorage shim before the store import.
// See _setupLocalStorage.ts for why.
import './_setupLocalStorage'
import { describe, it, expect, beforeEach } from 'vitest'
import { useErdStore, ERD_STORE_PERSIST_KEY } from '../stores/erdStore'

describe('erdStore', () => {
  beforeEach(() => {
    // Wipe persisted localStorage state so tests don't bleed into each other.
    localStorage.clear()
    // `reset()` only clears session UI state; layoutOverrides need explicit
    // clearing since it persists across tests.
    useErdStore.setState({
      defaultState: 'keys',
      expandedOverrides: {},
      layoutOverrides: {},
    })
  })

  describe('initial state', () => {
    it('starts with defaultState = "keys"', () => {
      expect(useErdStore.getState().defaultState).toBe('keys')
    })

    it('starts with empty expandedOverrides', () => {
      expect(useErdStore.getState().expandedOverrides).toEqual({})
    })

    it('starts with empty layoutOverrides', () => {
      expect(useErdStore.getState().layoutOverrides).toEqual({})
    })

    it('getEffectiveState returns defaultState for an unknown uid', () => {
      expect(useErdStore.getState().getEffectiveState('model.proj.unknown')).toBe('keys')
    })
  })

  describe('cycleNode', () => {
    it('adds an override on first call → effective state becomes "full"', () => {
      useErdStore.getState().cycleNode('model.proj.foo')
      expect(useErdStore.getState().getEffectiveState('model.proj.foo')).toBe('full')
      expect(useErdStore.getState().expandedOverrides['model.proj.foo']).toBe('full')
    })

    it('removes an existing override on second call → effective state reverts to default', () => {
      useErdStore.getState().cycleNode('model.proj.foo')
      useErdStore.getState().cycleNode('model.proj.foo')
      expect(useErdStore.getState().getEffectiveState('model.proj.foo')).toBe('keys')
      expect('model.proj.foo' in useErdStore.getState().expandedOverrides).toBe(false)
    })

    it('only mutates the targeted uid — siblings keep their overrides', () => {
      useErdStore.getState().cycleNode('model.proj.foo')
      useErdStore.getState().cycleNode('model.proj.bar')
      useErdStore.getState().cycleNode('model.proj.foo') // remove foo
      const state = useErdStore.getState()
      expect(state.getEffectiveState('model.proj.foo')).toBe('keys')
      expect(state.getEffectiveState('model.proj.bar')).toBe('full')
    })

    it('ignores the optional hasKeys argument (store is dumb — renderer enforces)', () => {
      useErdStore.getState().cycleNode('model.proj.foo', false)
      expect(useErdStore.getState().getEffectiveState('model.proj.foo')).toBe('full')
    })

    it('does not mutate the previous expandedOverrides object (immutability)', () => {
      const before = useErdStore.getState().expandedOverrides
      useErdStore.getState().cycleNode('model.proj.foo')
      const after = useErdStore.getState().expandedOverrides
      expect(after).not.toBe(before)
    })
  })

  describe('setDefaultState', () => {
    it('changes effective state for non-overridden uids', () => {
      useErdStore.getState().setDefaultState('compact')
      expect(useErdStore.getState().getEffectiveState('model.proj.foo')).toBe('compact')
    })

    it('preserves overrides across default-state changes', () => {
      useErdStore.getState().cycleNode('model.proj.foo')
      useErdStore.getState().setDefaultState('compact')
      expect(useErdStore.getState().getEffectiveState('model.proj.foo')).toBe('full')
      expect(useErdStore.getState().getEffectiveState('model.proj.bar')).toBe('compact')
    })

    it('cycles through all three default states', () => {
      useErdStore.getState().setDefaultState('full')
      expect(useErdStore.getState().defaultState).toBe('full')
      useErdStore.getState().setDefaultState('compact')
      expect(useErdStore.getState().defaultState).toBe('compact')
      useErdStore.getState().setDefaultState('keys')
      expect(useErdStore.getState().defaultState).toBe('keys')
    })
  })

  describe('reset', () => {
    it('clears all overrides and restores default state to "keys"', () => {
      useErdStore.getState().cycleNode('model.proj.foo')
      useErdStore.getState().cycleNode('model.proj.bar')
      useErdStore.getState().setDefaultState('compact')

      useErdStore.getState().reset()

      const state = useErdStore.getState()
      expect(state.defaultState).toBe('keys')
      expect(state.expandedOverrides).toEqual({})
    })

    it('does NOT clear layoutOverrides (those are persistent)', () => {
      useErdStore.getState().setNodePosition('proj_a', 'm.a.x', { x: 10, y: 20 })
      useErdStore.getState().reset()
      expect(useErdStore.getState().layoutOverrides).toEqual({
        proj_a: { 'm.a.x': { x: 10, y: 20 } },
      })
    })
  })

  describe('setNodePosition', () => {
    it('records a position under the given project key', () => {
      useErdStore.getState().setNodePosition('jaffle_shop', 'model.j.orders', {
        x: 123,
        y: 456,
      })
      const overrides = useErdStore.getState().getProjectOverrides('jaffle_shop')
      expect(overrides['model.j.orders']).toEqual({ x: 123, y: 456 })
    })

    it('overwrites an existing position for the same uid', () => {
      useErdStore.getState().setNodePosition('p', 'm.x', { x: 1, y: 2 })
      useErdStore.getState().setNodePosition('p', 'm.x', { x: 9, y: 9 })
      expect(useErdStore.getState().getProjectOverrides('p')['m.x']).toEqual({
        x: 9,
        y: 9,
      })
    })

    it('keeps separate scopes per project key', () => {
      useErdStore.getState().setNodePosition('p1', 'm.x', { x: 1, y: 1 })
      useErdStore.getState().setNodePosition('p2', 'm.x', { x: 2, y: 2 })
      const s = useErdStore.getState()
      expect(s.getProjectOverrides('p1')['m.x']).toEqual({ x: 1, y: 1 })
      expect(s.getProjectOverrides('p2')['m.x']).toEqual({ x: 2, y: 2 })
    })

    it('writes through to localStorage under the documented key', () => {
      useErdStore.getState().setNodePosition('proj', 'm.a', { x: 7, y: 8 })
      const raw = localStorage.getItem(ERD_STORE_PERSIST_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!)
      // Zustand persist wraps state under `state` with a version field.
      expect(parsed.state.layoutOverrides).toEqual({
        proj: { 'm.a': { x: 7, y: 8 } },
      })
    })

    it('does not mutate the previous layoutOverrides object (immutability)', () => {
      useErdStore.getState().setNodePosition('p', 'm.a', { x: 1, y: 1 })
      const before = useErdStore.getState().layoutOverrides
      useErdStore.getState().setNodePosition('p', 'm.b', { x: 2, y: 2 })
      const after = useErdStore.getState().layoutOverrides
      expect(after).not.toBe(before)
      expect(after.p).not.toBe(before.p)
    })
  })

  describe('resetLayout', () => {
    it('clears overrides for the targeted project key only', () => {
      useErdStore.getState().setNodePosition('p1', 'm.x', { x: 1, y: 1 })
      useErdStore.getState().setNodePosition('p1', 'm.y', { x: 2, y: 2 })
      useErdStore.getState().setNodePosition('p2', 'm.x', { x: 3, y: 3 })

      useErdStore.getState().resetLayout('p1')

      const s = useErdStore.getState()
      expect(s.getProjectOverrides('p1')).toEqual({})
      expect(s.getProjectOverrides('p2')).toEqual({ 'm.x': { x: 3, y: 3 } })
    })

    it('is a no-op when the project has no overrides', () => {
      useErdStore.getState().setNodePosition('p1', 'm.x', { x: 1, y: 1 })
      useErdStore.getState().resetLayout('does-not-exist')
      expect(useErdStore.getState().getProjectOverrides('p1')).toEqual({
        'm.x': { x: 1, y: 1 },
      })
    })

    it('persists the cleared state to localStorage', () => {
      useErdStore.getState().setNodePosition('p1', 'm.x', { x: 1, y: 1 })
      useErdStore.getState().setNodePosition('p2', 'm.y', { x: 2, y: 2 })
      useErdStore.getState().resetLayout('p1')

      const raw = localStorage.getItem(ERD_STORE_PERSIST_KEY)
      const parsed = JSON.parse(raw!)
      expect(parsed.state.layoutOverrides).toEqual({
        p2: { 'm.y': { x: 2, y: 2 } },
      })
    })
  })

  describe('persistence', () => {
    /**
     * Use Zustand's persist API directly to re-trigger the rehydrate
     * step. This is what happens at app startup: persist middleware reads
     * localStorage, parses, runs the merge fn, calls setState. Re-importing
     * the module isn't reliable under Vite/Vitest module caching, so we
     * exercise the API contract instead.
     */
    async function rehydrate() {
      // The persist API attaches a `.persist` namespace to the store hook.
      const result = (
        useErdStore as unknown as { persist: { rehydrate: () => Promise<void> | void } }
      ).persist.rehydrate()
      if (result instanceof Promise) await result
    }

    it('rehydrates layoutOverrides from seeded localStorage', async () => {
      localStorage.setItem(
        ERD_STORE_PERSIST_KEY,
        JSON.stringify({
          state: {
            layoutOverrides: {
              jaffle_shop: { 'model.j.orders': { x: 999, y: 888 } },
            },
          },
          version: 0,
        }),
      )
      await rehydrate()
      expect(useErdStore.getState().layoutOverrides).toEqual({
        jaffle_shop: { 'model.j.orders': { x: 999, y: 888 } },
      })
    })

    it('round-trips: setNodePosition writes to localStorage in the rehydratable shape', async () => {
      useErdStore.getState().setNodePosition('proj', 'm.x', { x: 42, y: 84 })
      // Snapshot what the persist middleware actually wrote.
      const raw = localStorage.getItem(ERD_STORE_PERSIST_KEY)
      expect(raw).not.toBeNull()
      // Now clear the in-memory store AND localStorage, then restore the raw
      // payload so rehydrate has something to read but the in-memory state
      // is empty. This simulates a fresh app load with prior data on disk.
      useErdStore.setState({ layoutOverrides: {} })
      localStorage.setItem(ERD_STORE_PERSIST_KEY, raw!)
      await rehydrate()
      expect(useErdStore.getState().layoutOverrides).toEqual({
        proj: { 'm.x': { x: 42, y: 84 } },
      })
    })

    it('falls back to empty overrides when localStorage JSON is malformed', async () => {
      localStorage.setItem(ERD_STORE_PERSIST_KEY, '{not valid json')
      await rehydrate()
      expect(useErdStore.getState().layoutOverrides).toEqual({})
    })

    it('falls back to empty overrides when persisted shape is unexpected', async () => {
      localStorage.setItem(
        ERD_STORE_PERSIST_KEY,
        JSON.stringify({ state: { layoutOverrides: 'not-an-object' }, version: 0 }),
      )
      await rehydrate()
      expect(useErdStore.getState().layoutOverrides).toEqual({})
    })
  })
})
