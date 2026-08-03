import type {
  ColumnLineageData,
  ColumnEdge,
  ColumnDownstreamDependency,
  LineageEdge,
  LineageNode,
} from '../types'
import {
  FIELD_LINEAGE_EDGE_COLOR,
  FIELD_PATH_BRANCH_PALETTE,
} from './columnTransforms'

const MAX_TRACE_DEPTH = 6

interface ColumnRef {
  modelId: string
  columnName: string
}

export interface TraceResult {
  edges: ColumnEdge[]
  /** Map of modelId -> Set of column names that participate in the trace */
  highlightedColumns: Map<string, Set<string>>
  /**
   * Per-branch colors when the selected field has multiple immediate upstream
   * leaves. ``columnColors``: modelId → (column → color). ``edgeColors``: keyed
   * by {@link columnEdgeKey}.
   */
  columnColors: Map<string, Map<string, string>>
  edgeColors: Map<string, string>
}

export function columnEdgeKey(edge: ColumnEdge): string {
  return `${edge.sourceModel}::${edge.sourceColumn}::${edge.targetModel}::${edge.targetColumn}`
}

/**
 * Assign a distinct color to each immediate upstream leaf of the selected field,
 * and paint that leaf's entire upstream chain (edges + columns) with the same
 * color. A single leaf → monochrome amber. Shared columns/edges keep the first
 * assigned color; the selected field itself stays amber.
 */
export function colorizeColumnTraceBranches(
  edges: readonly ColumnEdge[],
  selectedModelId: string,
  selectedColumn: string,
): Pick<TraceResult, 'columnColors' | 'edgeColors'> {
  const columnColors = new Map<string, Map<string, string>>()
  const edgeColors = new Map<string, string>()
  const selectedLower = selectedColumn.toLowerCase()

  const setCol = (model: string, column: string, color: string) => {
    let byCol = columnColors.get(model)
    if (!byCol) {
      byCol = new Map()
      columnColors.set(model, byCol)
    }
    const lower = column.toLowerCase()
    for (const key of byCol.keys()) {
      if (key.toLowerCase() === lower) return
    }
    byCol.set(column, color)
  }

  const direct = edges.filter(
    (e) =>
      e.targetModel === selectedModelId
      && e.targetColumn.toLowerCase() === selectedLower,
  )

  type Leaf = { model: string; column: string; intoSelected: ColumnEdge[] }
  const leaves: Leaf[] = []
  const leafIndex = new Map<string, number>()
  for (const edge of direct) {
    const key = `${edge.sourceModel}::${edge.sourceColumn.toLowerCase()}`
    let idx = leafIndex.get(key)
    if (idx === undefined) {
      idx = leaves.length
      leafIndex.set(key, idx)
      leaves.push({
        model: edge.sourceModel,
        column: edge.sourceColumn,
        intoSelected: [],
      })
    }
    leaves[idx]!.intoSelected.push(edge)
  }

  const paintAll = (color: string) => {
    for (const edge of edges) {
      edgeColors.set(columnEdgeKey(edge), color)
      setCol(edge.sourceModel, edge.sourceColumn, color)
      setCol(edge.targetModel, edge.targetColumn, color)
    }
    setCol(selectedModelId, selectedColumn, FIELD_LINEAGE_EDGE_COLOR)
  }

  if (leaves.length <= 1) {
    paintAll(FIELD_LINEAGE_EDGE_COLOR)
    return { columnColors, edgeColors }
  }

  const byTarget = new Map<string, ColumnEdge[]>()
  for (const edge of edges) {
    const key = `${edge.targetModel}::${edge.targetColumn.toLowerCase()}`
    const list = byTarget.get(key) ?? []
    list.push(edge)
    byTarget.set(key, list)
  }

  for (let i = 0; i < leaves.length; i++) {
    const color = FIELD_PATH_BRANCH_PALETTE[i % FIELD_PATH_BRANCH_PALETTE.length]!
    const leaf = leaves[i]!

    for (const edge of leaf.intoSelected) {
      edgeColors.set(columnEdgeKey(edge), color)
    }
    setCol(leaf.model, leaf.column, color)

    const queue: Array<{ model: string; column: string }> = [
      { model: leaf.model, column: leaf.column },
    ]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const cur = queue.shift()!
      const vk = `${cur.model}::${cur.column.toLowerCase()}`
      if (visited.has(vk)) continue
      visited.add(vk)
      setCol(cur.model, cur.column, color)

      for (const edge of byTarget.get(vk) ?? []) {
        const ek = columnEdgeKey(edge)
        if (!edgeColors.has(ek)) edgeColors.set(ek, color)
        queue.push({ model: edge.sourceModel, column: edge.sourceColumn })
      }
    }
  }

  // Selected field stays the shared focus color.
  const selectedMap = columnColors.get(selectedModelId) ?? new Map()
  for (const key of [...selectedMap.keys()]) {
    if (key.toLowerCase() === selectedLower) selectedMap.delete(key)
  }
  selectedMap.set(selectedColumn, FIELD_LINEAGE_EDGE_COLOR)
  columnColors.set(selectedModelId, selectedMap)

  // Downstream / leftover edges not claimed by a branch.
  for (const edge of edges) {
    const ek = columnEdgeKey(edge)
    if (!edgeColors.has(ek)) {
      edgeColors.set(ek, FIELD_LINEAGE_EDGE_COLOR)
      setCol(edge.sourceModel, edge.sourceColumn, FIELD_LINEAGE_EDGE_COLOR)
      setCol(edge.targetModel, edge.targetColumn, FIELD_LINEAGE_EDGE_COLOR)
    }
  }

  return { columnColors, edgeColors }
}

export function columnColorFor(
  columnColors: Map<string, Map<string, string>> | undefined,
  modelId: string,
  column: string,
): string | undefined {
  const byCol = columnColors?.get(modelId)
  if (!byCol) return undefined
  if (byCol.has(column)) return byCol.get(column)
  const lower = column.toLowerCase()
  for (const [key, color] of byCol) {
    if (key.toLowerCase() === lower) return color
  }
  return undefined
}

function finalizeTrace(
  edges: ColumnEdge[],
  highlightedColumns: Map<string, Set<string>>,
  selectedModelId: string,
  selectedColumn: string,
): TraceResult {
  const { columnColors, edgeColors } = colorizeColumnTraceBranches(
    edges,
    selectedModelId,
    selectedColumn,
  )
  return { edges, highlightedColumns, columnColors, edgeColors }
}

export interface ColumnPathFilterOptions {
  /** Follow column deps upstream from the selected field (default true). */
  includeUpstream?: boolean
  /** Follow column consumers downstream (default false). */
  includeDownstream?: boolean
  maxDepth?: number
  /** Always keep these model ids (e.g. page focal / pinned exposure). */
  alwaysKeep?: ReadonlySet<string> | readonly string[]
}

/**
 * Build a reverse index: for each (sourceModel, sourceColumn), find all
 * (targetModel, targetColumn) that reference it. Used for downstream tracing.
 */
export function buildReverseIndex(
  columnLineage: ColumnLineageData
): Map<string, ColumnRef[]> {
  const index = new Map<string, ColumnRef[]>()
  for (const [targetModel, columns] of Object.entries(columnLineage)) {
    for (const [targetColumn, deps] of Object.entries(columns)) {
      for (const dep of deps) {
        if (!dep.source_model || !dep.source_column) continue
        const key = `${dep.source_model}::${dep.source_column.toLowerCase()}`
        const refs = index.get(key) ?? []
        refs.push({ modelId: targetModel, columnName: targetColumn })
        index.set(key, refs)
      }
    }
  }
  return index
}

/**
 * Trace upstream columns: follow column_lineage[modelId][columnName] entries recursively.
 */
export function traceColumnUpstream(
  modelId: string,
  columnName: string,
  columnLineage: ColumnLineageData,
  maxDepth: number = MAX_TRACE_DEPTH,
): ColumnEdge[] {
  const edges: ColumnEdge[] = []
  const visited = new Set<string>()
  const queue: Array<{ model: string; column: string; depth: number }> = [
    { model: modelId, column: columnName, depth: 0 },
  ]

  while (queue.length > 0) {
    const { model, column, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    const deps = columnLineage[model]?.[column]
    if (!deps) continue

    for (const dep of deps) {
      if (!dep.source_model || !dep.source_column) continue
      if (dep.transformation === 'constant' || dep.transformation === 'untraced') continue

      const edgeKey = `${dep.source_model}::${dep.source_column}::${model}::${column}`
      if (visited.has(edgeKey)) continue
      visited.add(edgeKey)

      edges.push({
        sourceModel: dep.source_model,
        sourceColumn: dep.source_column,
        targetModel: model,
        targetColumn: column,
        transformation: dep.transformation,
        ...(dep.expression ? { expression: dep.expression } : {}),
      })

      queue.push({ model: dep.source_model, column: dep.source_column, depth: depth + 1 })
    }
  }

  return edges
}

/**
 * Trace downstream columns: find all models that reference (modelId, columnName)
 * as a source, then recurse.
 */
export function traceColumnDownstream(
  modelId: string,
  columnName: string,
  columnLineage: ColumnLineageData,
  reverseIndex: Map<string, ColumnRef[]>,
  maxDepth: number = MAX_TRACE_DEPTH,
): ColumnEdge[] {
  const edges: ColumnEdge[] = []
  const visited = new Set<string>()
  const queue: Array<{ model: string; column: string; depth: number }> = [
    { model: modelId, column: columnName, depth: 0 },
  ]

  while (queue.length > 0) {
    const { model, column, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    const key = `${model}::${column.toLowerCase()}`
    const consumers = reverseIndex.get(key)
    if (!consumers) continue

    for (const consumer of consumers) {
      const dep = columnLineage[consumer.modelId]?.[consumer.columnName]?.find(
        d =>
          d.source_model === model
          && d.source_column != null
          && d.source_column.toLowerCase() === column.toLowerCase(),
      )
      const edgeKey = `${model}::${column}::${consumer.modelId}::${consumer.columnName}`
      if (visited.has(edgeKey)) continue
      visited.add(edgeKey)

      edges.push({
        sourceModel: model,
        sourceColumn: column,
        targetModel: consumer.modelId,
        targetColumn: consumer.columnName,
        transformation: dep?.transformation ?? 'derived',
        ...(dep?.expression ? { expression: dep.expression } : {}),
      })

      queue.push({ model: consumer.modelId, column: consumer.columnName, depth: depth + 1 })
    }
  }

  return edges
}

/**
 * Get the full column trace result: upstream + downstream edges and all highlighted columns.
 */
export function getColumnTraceResult(
  modelId: string,
  columnName: string,
  columnLineage: ColumnLineageData,
  reverseIndex: Map<string, ColumnRef[]>,
  maxDepth: number = MAX_TRACE_DEPTH,
): TraceResult {
  const upstreamEdges = traceColumnUpstream(modelId, columnName, columnLineage, maxDepth)
  const downstreamEdges = traceColumnDownstream(modelId, columnName, columnLineage, reverseIndex, maxDepth)

  const allEdges = [...upstreamEdges, ...downstreamEdges]

  // Build highlighted columns map
  const highlightedColumns = new Map<string, Set<string>>()

  const addHighlight = (model: string, column: string) => {
    const existing = highlightedColumns.get(model)
    if (existing) {
      existing.add(column)
    } else {
      highlightedColumns.set(model, new Set([column]))
    }
  }

  // The selected column itself
  addHighlight(modelId, columnName)

  // All columns referenced in edges
  for (const edge of allEdges) {
    addHighlight(edge.sourceModel, edge.sourceColumn)
    addHighlight(edge.targetModel, edge.targetColumn)
  }

  return finalizeTrace(allEdges, highlightedColumns, modelId, columnName)
}

/**
 * Field-path column trace for exposure / PBI measures:
 * 1. Direct deps of the selected field (measure → mart columns)
 * 2. SQL column lineage upstream of each of those leaf columns
 *
 * Avoids shallow "mart only" graphs while still excluding unrelated table
 * parents of the exposure that are not on this field's column path.
 */
export function getFieldPathColumnTrace(
  modelId: string,
  columnName: string,
  columnLineage: ColumnLineageData,
  reverseIndex: Map<string, ColumnRef[]>,
  options: {
    includeUpstream?: boolean
    includeDownstream?: boolean
    leafSqlDepth?: number
  } = {},
): TraceResult {
  const includeUpstream = options.includeUpstream !== false
  const includeDownstream = options.includeDownstream === true
  const leafSqlDepth = options.leafSqlDepth ?? MAX_TRACE_DEPTH

  const directUpstream = includeUpstream
    ? traceColumnUpstream(modelId, columnName, columnLineage, 1)
    : []
  const directDownstream = includeDownstream
    ? traceColumnDownstream(modelId, columnName, columnLineage, reverseIndex, 1)
    : []

  const allEdges: ColumnEdge[] = [...directUpstream, ...directDownstream]
  const seenEdge = new Set(allEdges.map(
    (e) => `${e.sourceModel}::${e.sourceColumn}::${e.targetModel}::${e.targetColumn}`,
  ))

  const addUnique = (edges: ColumnEdge[]) => {
    for (const edge of edges) {
      const key = `${edge.sourceModel}::${edge.sourceColumn}::${edge.targetModel}::${edge.targetColumn}`
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      allEdges.push(edge)
    }
  }

  if (includeUpstream) {
    for (const edge of directUpstream) {
      addUnique(
        traceColumnUpstream(
          edge.sourceModel,
          edge.sourceColumn,
          columnLineage,
          leafSqlDepth,
        ),
      )
    }
  }
  if (includeDownstream) {
    for (const edge of directDownstream) {
      addUnique(
        traceColumnDownstream(
          edge.targetModel,
          edge.targetColumn,
          columnLineage,
          reverseIndex,
          leafSqlDepth,
        ),
      )
    }
  }

  const highlightedColumns = new Map<string, Set<string>>()
  const addHighlight = (model: string, column: string) => {
    const existing = highlightedColumns.get(model)
    if (existing) existing.add(column)
    else highlightedColumns.set(model, new Set([column]))
  }
  addHighlight(modelId, columnName)
  for (const edge of allEdges) {
    addHighlight(edge.sourceModel, edge.sourceColumn)
    addHighlight(edge.targetModel, edge.targetColumn)
  }

  return finalizeTrace(allEdges, highlightedColumns, modelId, columnName)
}

/**
 * Model ids on the selected field's column-lineage path (plus optional pins).
 */
export function collectColumnPathModelIds(
  modelId: string,
  columnName: string,
  columnLineage: ColumnLineageData,
  reverseIndex: Map<string, ColumnRef[]>,
  options: ColumnPathFilterOptions = {},
): Set<string> {
  const includeUpstream = options.includeUpstream !== false
  const includeDownstream = options.includeDownstream === true
  const maxDepth = options.maxDepth ?? MAX_TRACE_DEPTH

  const keep = new Set<string>([modelId])
  if (options.alwaysKeep) {
    for (const id of options.alwaysKeep) keep.add(id)
  }

  const upstreamEdges = includeUpstream
    ? traceColumnUpstream(modelId, columnName, columnLineage, maxDepth)
    : []
  const downstreamEdges = includeDownstream
    ? traceColumnDownstream(modelId, columnName, columnLineage, reverseIndex, maxDepth)
    : []

  for (const edge of [...upstreamEdges, ...downstreamEdges]) {
    keep.add(edge.sourceModel)
    keep.add(edge.targetModel)
  }

  return keep
}

/**
 * Narrow a table-level subgraph to models on a field's column lineage path.
 * Keeps existing table edges between survivors and fills gaps with model→model
 * edges derived from the column path (so removing unrelated parents does not
 * orphan path members when an intermediate table-only hop was dropped).
 */
export function filterSubgraphToColumnPath(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  pathModelIds: ReadonlySet<string>,
  columnEdges: readonly ColumnEdge[] = [],
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const keptNodes = nodes.filter((n) => pathModelIds.has(n.id))
  const keptIds = new Set(keptNodes.map((n) => n.id))

  const out: LineageEdge[] = []
  const seen = new Set<string>()
  const addEdge = (source: string, target: string, template?: LineageEdge) => {
    if (!keptIds.has(source) || !keptIds.has(target) || source === target) return
    const key = `${source}\0${target}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(
      template && template.source === source && template.target === target
        ? template
        : { source, target },
    )
  }

  for (const edge of edges) {
    addEdge(edge.source, edge.target, edge)
  }
  for (const edge of columnEdges) {
    addEdge(edge.sourceModel, edge.targetModel)
  }

  return { nodes: keptNodes, edges: out }
}

/**
 * Models referenced as column-lineage sources by any node already in the
 * subgraph — used to pull field-path tables into Columns mode even when they
 * are missing from dbt table-level depends_on (common for PBI exposures).
 */
export function collectColumnSourceModelIds(
  subgraphNodeIds: ReadonlySet<string> | readonly string[],
  columnLineage: ColumnLineageData,
): Set<string> {
  const inSubgraph = subgraphNodeIds instanceof Set
    ? subgraphNodeIds
    : new Set(subgraphNodeIds)
  const sources = new Set<string>()
  for (const nodeId of inSubgraph) {
    const cols = columnLineage[nodeId]
    if (!cols) continue
    for (const deps of Object.values(cols)) {
      for (const dep of deps) {
        if (!dep?.source_model) continue
        if (dep.transformation === 'constant' || dep.transformation === 'untraced') continue
        sources.add(dep.source_model)
      }
    }
  }
  return sources
}

/**
 * Add column-lineage source models (and connecting edges) that are absent from
 * the table subgraph. Prefer real lineage edges; fall back to model→model edges
 * implied by column deps so field paths stay connected.
 */
export function augmentSubgraphWithColumnSources(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  allNodes: readonly LineageNode[],
  allEdges: readonly LineageEdge[],
  columnLineage: ColumnLineageData,
): { nodes: LineageNode[]; edges: LineageEdge[] } {
  const byId = new Map(allNodes.map((n) => [n.id, n]))
  const keep = new Map(nodes.map((n) => [n.id, n]))
  const sources = collectColumnSourceModelIds([...keep.keys()], columnLineage)

  for (const id of sources) {
    if (keep.has(id)) continue
    const node = byId.get(id)
    if (node) keep.set(id, node)
  }

  if (keep.size === nodes.length) {
    return { nodes: [...nodes], edges: [...edges] }
  }

  const keptIds = new Set(keep.keys())
  const outEdges: LineageEdge[] = []
  const seen = new Set<string>()
  const addEdge = (source: string, target: string, template?: LineageEdge) => {
    if (!keptIds.has(source) || !keptIds.has(target) || source === target) return
    const key = `${source}\0${target}`
    if (seen.has(key)) return
    seen.add(key)
    outEdges.push(
      template && template.source === source && template.target === target
        ? template
        : { source, target },
    )
  }

  for (const edge of edges) addEdge(edge.source, edge.target, edge)
  for (const edge of allEdges) {
    if (keptIds.has(edge.source) && keptIds.has(edge.target)) {
      addEdge(edge.source, edge.target, edge)
    }
  }

  // Column-implied edges for injected sources (e.g. fct → exposure when dbt
  // depends_on omitted the fact table).
  for (const [targetId, cols] of Object.entries(columnLineage)) {
    if (!keptIds.has(targetId)) continue
    for (const deps of Object.values(cols)) {
      for (const dep of deps) {
        if (!dep?.source_model || !keptIds.has(dep.source_model)) continue
        if (dep.transformation === 'constant' || dep.transformation === 'untraced') continue
        addEdge(dep.source_model, targetId)
      }
    }
  }

  return { nodes: [...keep.values()], edges: outEdges }
}

/**
 * Sorted unique_ids of nodes in `subgraphNodes` that have column lineage —
 * either as a target in `columnLineage` or as a source referenced by another
 * node (mirroring the upstream-set derivation in LineageFlow.tsx). Used by
 * the bulk Expand-all / Collapse-all controls to enumerate candidates.
 *
 * Returns `[]` when `columnLineage` is null/undefined.
 */
export function getColumnLineageCandidateIds(
  subgraphNodes: ReadonlyArray<{ id: string }>,
  columnLineage: ColumnLineageData | null | undefined,
): string[] {
  if (!columnLineage) return []
  const upstream = new Set<string>()
  for (const colMap of Object.values(columnLineage)) {
    for (const deps of Object.values(colMap)) {
      for (const d of deps) {
        if (d?.source_model) upstream.add(d.source_model)
      }
    }
  }
  return subgraphNodes
    .filter(n => columnLineage[n.id] != null || upstream.has(n.id))
    .map(n => n.id)
    .sort()
}

export function buildDownstreamMap(
  modelId: string,
  columnLineage: ColumnLineageData,
): Record<string, ColumnDownstreamDependency[]> {
  const result: Record<string, ColumnDownstreamDependency[]> = {}

  // Scan all models' lineage to find references to columns from modelId
  for (const [targetModelId, columns] of Object.entries(columnLineage)) {
    if (targetModelId === modelId) continue

    for (const [targetColumn, deps] of Object.entries(columns)) {
      for (const dep of deps) {
        if (dep.source_model !== modelId || !dep.source_column) continue

        // Normalize to lowercase for case-insensitive matching
        // (Snowflake returns UPPERCASE, model columns are lowercase)
        const sourceCol = dep.source_column.toLowerCase()
        const existing = result[sourceCol] ?? []
        existing.push({
          target_model: targetModelId,
          target_column: targetColumn,
          transformation: dep.transformation,
        })
        result[sourceCol] = existing
      }
    }
  }

  return result
}
