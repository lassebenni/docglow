/**
 * Test-only side-effect module: installs a deterministic in-memory
 * `localStorage` shim onto `globalThis` BEFORE any consumer import runs.
 *
 * Why this file exists: Vitest 4 + Node 22 + jsdom interact poorly here.
 * - Node 22's experimental `localStorage` requires `--localstorage-file`.
 * - jsdom installs a `localStorage` proxy on `window`, but `globalThis.localStorage`
 *   ends up referring to the broken Node native implementation, missing
 *   `setItem` / `clear` etc.
 *
 * The Zustand `persist` middleware calls `createJSONStorage(() => localStorage)`
 * eagerly during module init, so we must install the shim before the
 * store module is imported. ES imports are evaluated in source order, so
 * any test that imports this file FIRST (before the store) will get the
 * shim.
 *
 * Usage:
 *   import './_setupLocalStorage'        // ← MUST come first
 *   import { useErdStore } from '../stores/erdStore'
 */

class MemStorage implements Storage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemStorage(),
  writable: true,
  configurable: true,
})
