import { describe, it, expect, beforeEach } from 'vitest'
import { useErdStore } from '../stores/erdStore'

describe('erdStore', () => {
  beforeEach(() => {
    useErdStore.getState().reset()
  })

  describe('initial state', () => {
    it('starts with defaultState = "keys"', () => {
      expect(useErdStore.getState().defaultState).toBe('keys')
    })

    it('starts with empty expandedOverrides', () => {
      expect(useErdStore.getState().expandedOverrides).toEqual({})
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
  })
})
