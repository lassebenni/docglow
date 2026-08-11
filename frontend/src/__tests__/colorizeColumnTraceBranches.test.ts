import { describe, it, expect } from 'vitest'
import type { ColumnEdge } from '../types'
import {
  colorizeColumnTraceBranches,
  columnColorFor,
  columnEdgeKey,
} from '../utils/columnLineageGraph'
import {
  FIELD_LINEAGE_EDGE_COLOR,
  FIELD_PATH_BRANCH_PALETTE,
} from '../utils/columnTransforms'

function edge(
  sourceModel: string,
  sourceColumn: string,
  targetModel: string,
  targetColumn: string,
): ColumnEdge {
  return {
    sourceModel,
    sourceColumn,
    targetModel,
    targetColumn,
    transformation: 'passthrough',
  }
}

describe('colorizeColumnTraceBranches', () => {
  it('uses amber for a single upstream leaf', () => {
    const edges = [
      edge('model.stg', 'customer_no', 'model.agg', 'customer_no'),
      edge('source.raw', 'customer_no', 'model.stg', 'customer_no'),
    ]
    const { columnColors, edgeColors } = colorizeColumnTraceBranches(
      edges,
      'model.agg',
      'customer_no',
    )
    expect(columnColorFor(columnColors, 'model.stg', 'customer_no')).toBe(
      FIELD_LINEAGE_EDGE_COLOR,
    )
    expect(columnColorFor(columnColors, 'source.raw', 'customer_no')).toBe(
      FIELD_LINEAGE_EDGE_COLOR,
    )
    expect(edgeColors.get(columnEdgeKey(edges[0]!))).toBe(FIELD_LINEAGE_EDGE_COLOR)
  })

  it('assigns a distinct color per immediate upstream leaf chain', () => {
    const edges = [
      edge('model.fct', 'customer_no', 'model.agg', 'customer_no'),
      edge('model.stg_header', 'customer_no', 'model.agg', 'customer_no'),
      edge('source.pos', 'customer_no', 'model.stg_header', 'customer_no'),
      edge('model.int', 'customer_no', 'model.fct', 'customer_no'),
    ]
    const { columnColors, edgeColors } = colorizeColumnTraceBranches(
      edges,
      'model.agg',
      'customer_no',
    )

    const fctColor = columnColorFor(columnColors, 'model.fct', 'customer_no')
    const stgColor = columnColorFor(columnColors, 'model.stg_header', 'customer_no')
    expect(fctColor).toBe(FIELD_PATH_BRANCH_PALETTE[0])
    expect(stgColor).toBe(FIELD_PATH_BRANCH_PALETTE[1])
    expect(fctColor).not.toBe(stgColor)

    // Upstream of each leaf shares that leaf's color
    expect(columnColorFor(columnColors, 'model.int', 'customer_no')).toBe(fctColor)
    expect(columnColorFor(columnColors, 'source.pos', 'customer_no')).toBe(stgColor)

    expect(edgeColors.get(columnEdgeKey(edges[0]!))).toBe(fctColor)
    expect(edgeColors.get(columnEdgeKey(edges[1]!))).toBe(stgColor)
    expect(edgeColors.get(columnEdgeKey(edges[2]!))).toBe(stgColor)
    expect(edgeColors.get(columnEdgeKey(edges[3]!))).toBe(fctColor)

    // Selected field stays shared amber
    expect(columnColorFor(columnColors, 'model.agg', 'customer_no')).toBe(
      FIELD_LINEAGE_EDGE_COLOR,
    )
  })
})
