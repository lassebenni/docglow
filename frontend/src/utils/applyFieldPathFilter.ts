import type { ColumnLineageData, LineageEdge, LineageNode } from '../types'
import type { LineageDirection } from './graph'
import {
  augmentSubgraphWithColumnSources,
  buildReverseIndex,
  filterSubgraphToColumnPath,
  getFieldPathColumnTrace,
} from './columnLineageGraph'

export interface FieldPathSelection {
  modelId: string
  columnName: string
}

/**
 * Columns-mode subgraph: first pull in models referenced by column lineage
 * (so field sources missing from dbt depends_on still appear), then optionally
 * narrow to the selected field's path (measure leaves + their SQL upstream).
 */
export function buildColumnsModeSubgraph(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  options: {
    allNodes: readonly LineageNode[]
    allEdges: readonly LineageEdge[]
    columnLineage: ColumnLineageData | null | undefined
    fieldPathOnly: boolean
    selectedColumn: FieldPathSelection | null
    direction: LineageDirection
    alwaysKeep?: ReadonlySet<string> | readonly string[]
  },
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const {
    allNodes,
    allEdges,
    columnLineage,
    fieldPathOnly,
    selectedColumn,
    direction,
    alwaysKeep,
  } = options

  if (!columnLineage) {
    return { nodes: [...nodes], edges: [...edges] }
  }

  const augmented = augmentSubgraphWithColumnSources(
    nodes,
    edges,
    allNodes,
    allEdges,
    columnLineage,
  )

  return applyFieldPathFilter(augmented.nodes, augmented.edges, {
    enabled: fieldPathOnly,
    selectedColumn,
    columnLineage,
    direction,
    alwaysKeep,
    allNodes,
    allEdges,
  })
}

/**
 * When enabled and a field is selected, narrow the subgraph to models on that
 * field's column-lineage path: direct measure→mart deps plus SQL upstream of
 * those leaf columns. Injects path models from ``allNodes`` when missing from
 * the table subgraph (e.g. intermediates not in exposure depends_on).
 */
export function applyFieldPathFilter(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  options: {
    enabled: boolean
    selectedColumn: FieldPathSelection | null
    columnLineage: ColumnLineageData | null | undefined
    direction: LineageDirection
    alwaysKeep?: ReadonlySet<string> | readonly string[]
    allNodes?: readonly LineageNode[]
    allEdges?: readonly LineageEdge[]
  },
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const {
    enabled,
    selectedColumn,
    columnLineage,
    direction,
    alwaysKeep,
    allNodes,
    allEdges,
  } = options
  if (!enabled || !selectedColumn || !columnLineage) {
    return { nodes: [...nodes], edges: [...edges] }
  }

  const reverseIndex = buildReverseIndex(columnLineage)
  const includeUpstream = direction !== 'downstream'
  const includeDownstream = direction !== 'upstream'

  const trace = getFieldPathColumnTrace(
    selectedColumn.modelId,
    selectedColumn.columnName,
    columnLineage,
    reverseIndex,
    { includeUpstream, includeDownstream },
  )

  const pathIds = new Set<string>([selectedColumn.modelId])
  if (alwaysKeep) {
    for (const id of alwaysKeep) pathIds.add(id)
  }
  for (const edge of trace.edges) {
    pathIds.add(edge.sourceModel)
    pathIds.add(edge.targetModel)
  }

  const catalog = allNodes ?? nodes
  const byId = new Map(catalog.map((n) => [n.id, n]))
  const merged = new Map(nodes.map((n) => [n.id, n]))
  for (const id of pathIds) {
    if (!merged.has(id)) {
      const node = byId.get(id)
      if (node) merged.set(id, node)
    }
  }

  const edgePool = [...edges, ...(allEdges ?? [])]
  return filterSubgraphToColumnPath(
    [...merged.values()],
    edgePool,
    pathIds,
    trace.edges,
  )
}
