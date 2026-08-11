import { describe, expect, it } from 'vitest'
import type { ColumnLineageData, LineageEdge, LineageNode } from '../types'
import {
  applyFieldPathFilter,
  buildColumnsModeSubgraph,
} from '../utils/applyFieldPathFilter'
import {
  augmentSubgraphWithColumnSources,
  collectColumnPathModelIds,
  filterSubgraphToColumnPath,
  buildReverseIndex,
} from '../utils/columnLineageGraph'

function node(id: string): LineageNode {
  return {
    id,
    name: id.split('.').pop() ?? id,
    resource_type: id.startsWith('exposure.') ? 'exposure' : 'model',
    materialization: 'table',
    schema: 'analytics',
    test_status: 'none',
    has_description: false,
    folder: '',
    tags: [],
  }
}

const allNodes: LineageNode[] = [
  node('exposure.x.dash'),
  node('model.x.mart_a'),
  node('model.x.mart_b'),
  node('model.x.unrelated'),
  node('model.x.stg'),
  node('model.x.fct'), // field source NOT in table depends_on
]

const allEdges: LineageEdge[] = [
  { source: 'model.x.mart_a', target: 'exposure.x.dash' },
  { source: 'model.x.mart_b', target: 'exposure.x.dash' },
  { source: 'model.x.unrelated', target: 'exposure.x.dash' },
  { source: 'model.x.stg', target: 'model.x.mart_a' },
]

/** Table subgraph: exposure parents only — fct missing (like PBI depends_on). */
const tableNodes = allNodes.filter((n) => n.id !== 'model.x.fct' && n.id !== 'model.x.stg')
const tableEdges = allEdges.filter((e) => e.source !== 'model.x.stg')

const columnLineage: ColumnLineageData = {
  'exposure.x.dash': {
    'Netto Omzet': [
      {
        source_model: 'model.x.mart_a',
        source_column: 'amt_sales',
        transformation: 'passthrough',
      },
      {
        source_model: 'model.x.mart_b',
        source_column: 'amt_service',
        transformation: 'passthrough',
      },
    ],
    Webomzet: [
      {
        source_model: 'model.x.fct',
        source_column: 'amt_sales',
        transformation: 'aggregated',
      },
    ],
  },
  'model.x.mart_a': {
    amt_sales: [
      {
        source_model: 'model.x.stg',
        source_column: 'amt_sales',
        transformation: 'passthrough',
      },
    ],
  },
}

describe('collectColumnPathModelIds', () => {
  it('collects upstream models for a selected field', () => {
    const ids = collectColumnPathModelIds(
      'exposure.x.dash',
      'Netto Omzet',
      columnLineage,
      buildReverseIndex(columnLineage),
      { alwaysKeep: ['exposure.x.dash'] },
    )
    expect([...ids].sort()).toEqual([
      'exposure.x.dash',
      'model.x.mart_a',
      'model.x.mart_b',
      'model.x.stg',
    ])
  })
})

describe('filterSubgraphToColumnPath', () => {
  it('drops unrelated parents and keeps field-path models', () => {
    const path = new Set([
      'exposure.x.dash',
      'model.x.mart_a',
      'model.x.mart_b',
      'model.x.stg',
    ])
    const result = filterSubgraphToColumnPath(allNodes, allEdges, path)
    expect(result.nodes.map((n) => n.id).sort()).toEqual([...path].sort())
    expect(result.nodes.some((n) => n.id === 'model.x.unrelated')).toBe(false)
  })

  it('adds column-derived edges when table intermediates are missing', () => {
    const sparseNodes = [node('a'), node('c')]
    const sparseEdges: LineageEdge[] = []
    const result = filterSubgraphToColumnPath(
      sparseNodes,
      sparseEdges,
      new Set(['a', 'c']),
      [
        {
          sourceModel: 'a',
          sourceColumn: 'x',
          targetModel: 'c',
          targetColumn: 'y',
          transformation: 'derived',
        },
      ],
    )
    expect(result.edges).toEqual([{ source: 'a', target: 'c' }])
  })
})

describe('augmentSubgraphWithColumnSources', () => {
  it('injects field-source models missing from dbt depends_on', () => {
    const result = augmentSubgraphWithColumnSources(
      tableNodes,
      tableEdges,
      allNodes,
      allEdges,
      columnLineage,
    )
    expect(result.nodes.map((n) => n.id)).toContain('model.x.fct')
    expect(
      result.edges.some((e) => e.source === 'model.x.fct' && e.target === 'exposure.x.dash'),
    ).toBe(true)
  })
})

describe('buildColumnsModeSubgraph', () => {
  it('adds missing field sources in Columns mode', () => {
    const result = buildColumnsModeSubgraph(tableNodes, tableEdges, {
      allNodes,
      allEdges,
      columnLineage,
      fieldPathOnly: false,
      selectedColumn: null,
      direction: 'upstream',
    })
    expect(result.nodes.map((n) => n.id)).toContain('model.x.fct')
  })

  it('field path only keeps Webomzet path including injected fct', () => {
    const result = buildColumnsModeSubgraph(tableNodes, tableEdges, {
      allNodes,
      allEdges,
      columnLineage,
      fieldPathOnly: true,
      selectedColumn: { modelId: 'exposure.x.dash', columnName: 'Webomzet' },
      direction: 'upstream',
      alwaysKeep: ['exposure.x.dash'],
    })
    const ids = result.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['exposure.x.dash', 'model.x.fct'])
  })

  it('field path only follows SQL upstream of leaf mart columns', () => {
    const result = buildColumnsModeSubgraph(tableNodes, tableEdges, {
      allNodes,
      allEdges,
      columnLineage,
      fieldPathOnly: true,
      selectedColumn: { modelId: 'exposure.x.dash', columnName: 'Netto Omzet' },
      direction: 'upstream',
      alwaysKeep: ['exposure.x.dash'],
    })
    const ids = result.nodes.map((n) => n.id)
    expect(ids).toContain('model.x.mart_a')
    expect(ids).toContain('model.x.mart_b')
    expect(ids).toContain('model.x.stg') // SQL parent of mart_a.amt_sales
    expect(ids).not.toContain('model.x.unrelated')
  })
})

describe('applyFieldPathFilter', () => {
  it('no-ops when disabled or no selection', () => {
    const off = applyFieldPathFilter(allNodes, allEdges, {
      enabled: false,
      selectedColumn: { modelId: 'exposure.x.dash', columnName: 'Netto Omzet' },
      columnLineage,
      direction: 'upstream',
    })
    expect(off.nodes).toHaveLength(allNodes.length)

    const noSel = applyFieldPathFilter(allNodes, allEdges, {
      enabled: true,
      selectedColumn: null,
      columnLineage,
      direction: 'upstream',
    })
    expect(noSel.nodes).toHaveLength(allNodes.length)
  })

  it('keeps field-path tables including SQL upstream of leaves', () => {
    const result = applyFieldPathFilter(allNodes, allEdges, {
      enabled: true,
      selectedColumn: { modelId: 'exposure.x.dash', columnName: 'Netto Omzet' },
      columnLineage,
      direction: 'upstream',
      alwaysKeep: ['exposure.x.dash'],
      allNodes,
      allEdges,
    })
    const ids = result.nodes.map((n) => n.id).sort()
    expect(ids).toEqual([
      'exposure.x.dash',
      'model.x.mart_a',
      'model.x.mart_b',
      'model.x.stg',
    ])
    expect(ids).not.toContain('model.x.unrelated')
  })
})
