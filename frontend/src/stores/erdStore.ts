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
 *
 * v1.1 / DOC-99 U2: also persists drag-rearranged node positions to
 * localStorage. `layoutOverrides` is scoped per project key (see
 * `utils/erdProjectKey.ts`) so switching to a different docglow site doesn't
 * carry stale positions over. Only `layoutOverrides` is persisted — the
 * `defaultState` toggle and per-node `expandedOverrides` remain
 * session-scoped (matches DOC-215 behavior).
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type ErdNodeState = 'compact' | 'keys' | 'full'

export interface ErdNodePos {
  readonly x: number
  readonly y: number
}

const DEFAULT_NODE_STATE: ErdNodeState = 'keys'

/** localStorage key used by the persist middleware. Bumped if the persisted
 *  shape changes incompatibly. Shape v1: `{ layoutOverrides: { [project]: { [uid]: {x,y} } } }`. */
export const ERD_STORE_PERSIST_KEY = 'docglow-erd-v1'

interface ErdStoreState {
  readonly defaultState: ErdNodeState
  readonly expandedOverrides: Readonly<Record<string, 'full'>>
  /**
   * Per-project drag-position overrides. Outer key is the project key
   * (`metadata.project_name`, falling back to `_default_`). Inner key is
   * the model `unique_id`. Persisted to localStorage under
   * `ERD_STORE_PERSIST_KEY`.
   */
  readonly layoutOverrides: Readonly<Record<string, Readonly<Record<string, ErdNodePos>>>>
  /**
   * Display options slice (DOC-99 U3). Session-scoped — explicitly excluded
   * from `partialize` so the user's choice resets each session (matches
   * origin §5.6 default-OFF semantic — they have to opt back in).
   */
  readonly showOrphans: boolean
  readonly setShowOrphans: (next: boolean) => void
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
  /**
   * Persist a drag-rearranged node position for `uid` under `projectKey`.
   * Wired from `<ReactFlow onNodeDragStop>` in `ErdCanvas`.
   */
  readonly setNodePosition: (projectKey: string, uid: string, pos: ErdNodePos) => void
  /**
   * Clear all node-position overrides for `projectKey`. Other projects'
   * overrides are preserved.
   */
  readonly resetLayout: (projectKey: string) => void
  /** Selector: the override map for `projectKey` (empty object if none). */
  readonly getProjectOverrides: (projectKey: string) => Readonly<Record<string, ErdNodePos>>
  readonly reset: () => void
}

const EMPTY_OVERRIDES: Readonly<Record<string, ErdNodePos>> = Object.freeze({})

export const useErdStore = create<ErdStoreState>()(
  persist(
    (set, get) => ({
      defaultState: DEFAULT_NODE_STATE,
      expandedOverrides: {},
      layoutOverrides: {},
      showOrphans: false,

      setShowOrphans: (next) => {
        set({ showOrphans: next })
      },

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

      setNodePosition: (projectKey, uid, pos) => {
        const { layoutOverrides } = get()
        const projectMap = layoutOverrides[projectKey] ?? {}
        // Immutable update: new inner map, new outer map.
        const nextProject = { ...projectMap, [uid]: { x: pos.x, y: pos.y } }
        set({
          layoutOverrides: { ...layoutOverrides, [projectKey]: nextProject },
        })
      },

      resetLayout: (projectKey) => {
        const { layoutOverrides } = get()
        if (!(projectKey in layoutOverrides)) return
        // Drop the entry for `projectKey`, preserve all others.
        const next: Record<string, Record<string, ErdNodePos>> = {}
        for (const key of Object.keys(layoutOverrides)) {
          if (key === projectKey) continue
          next[key] = layoutOverrides[key]
        }
        set({ layoutOverrides: next })
      },

      getProjectOverrides: (projectKey) => {
        return get().layoutOverrides[projectKey] ?? EMPTY_OVERRIDES
      },

      reset: () => {
        // NOTE: `reset()` clears the session-scoped UI state (default node
        // state + per-node `expandedOverrides` + `showOrphans`) but
        // intentionally leaves persisted `layoutOverrides` alone — call
        // `resetLayout(projectKey)` explicitly to clear drag positions.
        set({
          defaultState: DEFAULT_NODE_STATE,
          expandedOverrides: {},
          showOrphans: false,
        })
      },
    }),
    {
      name: ERD_STORE_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist `layoutOverrides` only. The default-state toggle, per-node
      // expanded overrides, and `showOrphans` are session-scoped — they
      // intentionally reset on each session (DOC-215 + DOC-99 U3 / origin §5.6
      // default-OFF semantic for orphan visibility).
      partialize: (state) => ({ layoutOverrides: state.layoutOverrides }),
      // Defensive: malformed JSON or future-shape mismatch → fall back to
      // empty overrides instead of throwing. Zustand's persist middleware
      // already swallows JSON.parse errors and calls `onRehydrateStorage`
      // with an error, but we also coerce a non-object `layoutOverrides`
      // back to `{}` here to be belt-and-braces about it.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ErdStoreState>
        const overrides =
          p.layoutOverrides && typeof p.layoutOverrides === 'object'
            ? p.layoutOverrides
            : {}
        return { ...current, layoutOverrides: overrides }
      },
    },
  ),
)
