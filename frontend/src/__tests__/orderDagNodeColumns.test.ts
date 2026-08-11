import { describe, it, expect } from 'vitest'
import { orderDagNodeColumns } from '../components/lineage/DagNode'

const cols = Array.from({ length: 25 }, (_, i) => `col_${i}`)

describe('orderDagNodeColumns', () => {
  it('keeps catalog order on the selected/clicked node', () => {
    const hot = new Set(['col_22'])
    const ordered = orderDagNodeColumns(cols, hot, { isSelectedNode: true, maxVisible: 20 })
    expect(ordered).toEqual(cols)
  })

  it('keeps catalog order on parents when matches are already visible', () => {
    const hot = new Set(['col_3', 'col_5'])
    const ordered = orderDagNodeColumns(cols, hot, { isSelectedNode: false, maxVisible: 20 })
    expect(ordered).toEqual(cols)
  })

  it('promotes matches on parents only when below the visible window', () => {
    const hot = new Set(['col_22', 'col_3'])
    const ordered = orderDagNodeColumns(cols, hot, { isSelectedNode: false, maxVisible: 20 })
    expect(ordered.slice(0, 2)).toEqual(['col_3', 'col_22'])
    expect(ordered.slice(2)).toEqual(cols.filter((c) => c !== 'col_3' && c !== 'col_22'))
  })

  it('injects lineage-only columns missing from catalog', () => {
    const hot = new Set(['ghost_col'])
    const ordered = orderDagNodeColumns(['a', 'b'], hot, {
      isSelectedNode: false,
      maxVisible: 20,
    })
    // Injected at end; still within visible window → no promote
    expect(ordered).toEqual(['a', 'b', 'ghost_col'])
  })

  it('promotes injected columns that land below the fold', () => {
    const base = Array.from({ length: 20 }, (_, i) => `col_${i}`)
    const hot = new Set(['ghost_col'])
    const ordered = orderDagNodeColumns(base, hot, { isSelectedNode: false, maxVisible: 20 })
    // ghost appended at index 20 (≥ maxVisible) → promote
    expect(ordered[0]).toBe('ghost_col')
    expect(ordered.slice(1)).toEqual(base)
  })
})
