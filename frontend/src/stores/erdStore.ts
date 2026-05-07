/**
 * Zustand store for ERD node-state UI.
 *
 * Implements origin requirements §5.1:
 *   - Top-bar segmented control sets the *default* node state for all nodes.
 *   - Click on a node toggles that single node up to `full` (per-node override).
 *   - A second click resets that node back to whatever the current default is.
 *   - Overrides survive default-state changes (set default to `keys`, expand
 *     `orders` to `full`, switch default to `compact`, `orders` stays `full`).
 *
 * The store is intentionally "dumb": it does NOT enforce the §5.2 rule that
 * "if model has zero key columns, force compact regardless of default" —
 * that constraint belongs to the renderer (which is the only place that
 * knows the key-column count for a uid). Keeping it out of the store means
 * the store has no dependency on payload data and stays trivially testable.
 */

import { create } from 'zustand'

export type ErdNodeState = 'compact' | 'keys' | 'full'

const DEFAULT_NODE_STATE: ErdNodeState = 'keys'

interface ErdStoreState {
  readonly defaultState: ErdNodeState
  readonly expandedOverrides: Readonly<Record<string, 'full'>>
  readonly setDefaultState: (state: ErdNodeState) => void
  /**
   * Toggle the per-node override for `uid`.
   *
   * - If `uid` currently has an override → remove it (revert to default).
   * - Otherwise → add a `'full'` override.
   *
   * The `hasKeys` argument is accepted for API symmetry with callers that
   * may want to gate UI affordances ("if 0 keys, don't even show the
   * affordance"). The store itself does NOT consult it — see file header.
   */
  readonly cycleNode: (uid: string, hasKeys?: boolean) => void
  /**
   * Selector returning the effective state for `uid`: the override if one
   * is set, otherwise the current `defaultState`. Renderers may further
   * downgrade this to `compact` if the model has zero key columns.
   */
  readonly getEffectiveState: (uid: string) => ErdNodeState
  readonly reset: () => void
}

export const useErdStore = create<ErdStoreState>()((set, get) => ({
  defaultState: DEFAULT_NODE_STATE,
  expandedOverrides: {},

  setDefaultState: (state) => {
    set({ defaultState: state })
  },

  cycleNode: (uid, _hasKeys) => {
    const { expandedOverrides } = get()
    const next = { ...expandedOverrides }
    if (uid in next) {
      delete next[uid]
    } else {
      next[uid] = 'full'
    }
    set({ expandedOverrides: next })
  },

  getEffectiveState: (uid) => {
    const { expandedOverrides, defaultState } = get()
    return expandedOverrides[uid] ?? defaultState
  },

  reset: () => {
    set({ defaultState: DEFAULT_NODE_STATE, expandedOverrides: {} })
  },
}))
