import type {
  ColumnEdge,
  SqlGraphColumnDep,
  SqlGraphColumnLineage,
  TransformationType,
} from '../types'
import { colorizeColumnTraceBranches, columnEdgeKey } from './columnLineageGraph'

export function colKey(nodeId: string, column: string): string {
  return `${nodeId}\0${column}`
}

export interface ColumnPathStep {
  nodeId: string
  column: string
  transformation?: SqlGraphColumnDep['transformation']
  expression?: string
}

export interface ColumnPathResult {
  /** Upstream roots → selected → downstream (focus column only) */
  steps: ColumnPathStep[]
  keys: Set<string>
  /** Structure edges that carry the path: `${source}\0${target}` */
  edgeKeys: Set<string>
  /** Column-level hops for branch coloring (same shape as columns-mode trace). */
  columnEdges: ColumnEdge[]
  /** nodeId → (column → branch color); selected field stays amber. */
  columnColors: Map<string, Map<string, string>>
  /** keyed by {@link columnEdgeKey} */
  edgeColors: Map<string, string>
}

/**
 * Trace a column through sql_graph.column_lineage:
 * - upstream: selected field + every column it depends on (expression inputs)
 * - downstream: only consumers of the **selected** field (not of its upstream inputs)
 *
 * Same-node sibling passthroughs of expression inputs stay unhighlighted.
 */
export function collectColumnPath(
  lineage: SqlGraphColumnLineage | undefined,
  nodeId: string,
  column: string,
): ColumnPathResult {
  const keys = new Set<string>()
  const edgeKeys = new Set<string>()
  const emptyColors = {
    columnColors: new Map<string, Map<string, string>>(),
    edgeColors: new Map<string, string>(),
  }
  if (!lineage) {
    keys.add(colKey(nodeId, column))
    return {
      steps: [{ nodeId, column }],
      keys,
      edgeKeys,
      columnEdges: [],
      ...emptyColors,
    }
  }
  const graphLineage = lineage

  type Link = { from: ColumnPathStep; to: ColumnPathStep; via: SqlGraphColumnDep }
  const links: Link[] = []
  const seenUp = new Set<string>()

  function walkUp(nid: string, col: string): void {
    const k = colKey(nid, col)
    if (seenUp.has(k)) return
    seenUp.add(k)
    keys.add(k)
    const deps = graphLineage[nid]?.[col]
    if (!deps?.length) return
    for (const dep of deps) {
      // Constants / untraced often have a node stub with no column — skip those
      // so we do not invent empty-column highlights on parent CTEs.
      if (!dep.source_node || !dep.source_column) continue
      keys.add(colKey(dep.source_node, dep.source_column))
      edgeKeys.add(`${dep.source_node}\0${nid}`)
      links.push({
        from: {
          nodeId: dep.source_node,
          column: dep.source_column,
        },
        to: {
          nodeId: nid,
          column: col,
          transformation: dep.transformation,
          expression: dep.expression,
        },
        via: dep,
      })
      walkUp(dep.source_node, dep.source_column)
    }
  }

  walkUp(nodeId, column)

  // Downstream of the focus column only (not of every upstream input key)
  const seenDown = new Set([colKey(nodeId, column)])
  let grew = true
  while (grew) {
    grew = false
    for (const [tid, cols] of Object.entries(graphLineage)) {
      for (const [tcol, deps] of Object.entries(cols)) {
        const tk = colKey(tid, tcol)
        if (seenDown.has(tk)) continue
        for (const dep of deps) {
          if (!dep.source_node || !dep.source_column) continue
          const sk = colKey(dep.source_node, dep.source_column)
          if (!seenDown.has(sk)) continue
          seenDown.add(tk)
          keys.add(tk)
          edgeKeys.add(`${dep.source_node}\0${tid}`)
          links.push({
            from: { nodeId: dep.source_node, column: dep.source_column },
            to: {
              nodeId: tid,
              column: tcol,
              transformation: dep.transformation,
              expression: dep.expression,
            },
            via: dep,
          })
          grew = true
        }
      }
    }
  }

  const steps = orderPathSteps(nodeId, column, links, keys)
  const columnEdges = linksToColumnEdges(links)
  const { columnColors, edgeColors } = colorizeColumnTraceBranches(
    columnEdges,
    nodeId,
    column,
  )
  return { steps, keys, edgeKeys, columnEdges, columnColors, edgeColors }
}

function linksToColumnEdges(
  links: { from: ColumnPathStep; to: ColumnPathStep; via: SqlGraphColumnDep }[],
): ColumnEdge[] {
  const out: ColumnEdge[] = []
  const seen = new Set<string>()
  for (const l of links) {
    const edge: ColumnEdge = {
      sourceModel: l.from.nodeId,
      sourceColumn: l.from.column,
      targetModel: l.to.nodeId,
      targetColumn: l.to.column,
      transformation: (l.via.transformation ?? 'unknown') as TransformationType,
      expression: l.via.expression,
    }
    const k = columnEdgeKey(edge)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(edge)
  }
  return out
}

function orderPathSteps(
  focusNode: string,
  focusCol: string,
  links: { from: ColumnPathStep; to: ColumnPathStep; via: SqlGraphColumnDep }[],
  keys: Set<string>,
): ColumnPathStep[] {
  // Prefer a single chain through the focus column.
  // Find roots (nodes in keys with no upstream within path).
  const hasIncoming = new Set<string>()
  for (const l of links) {
    hasIncoming.add(colKey(l.to.nodeId, l.to.column))
  }
  const roots = [...keys].filter(k => !hasIncoming.has(k))

  // BFS from roots along links until we pass focus; keep first path that hits focus
  const children = new Map<
    string,
    { next: string; xform: SqlGraphColumnDep['transformation']; expression?: string }[]
  >()
  for (const l of links) {
    const fromK = colKey(l.from.nodeId, l.from.column)
    const toK = colKey(l.to.nodeId, l.to.column)
    const list = children.get(fromK) ?? []
    list.push({
      next: toK,
      xform: l.via.transformation,
      expression: l.via.expression,
    })
    children.set(fromK, list)
  }

  const focusK = colKey(focusNode, focusCol)
  let best: ColumnPathStep[] | null = null

  function parseKey(k: string): { nodeId: string; column: string } {
    const i = k.indexOf('\0')
    return { nodeId: k.slice(0, i), column: k.slice(i + 1) }
  }

  function dfs(curr: string, path: ColumnPathStep[], hitFocus: boolean): void {
    if (best && hitFocus && path.length >= best.length) return
    const kids = children.get(curr) ?? []
    if (kids.length === 0) {
      if (hitFocus && (!best || path.length > best.length)) {
        best = path
      }
      return
    }
    for (const { next, xform, expression } of kids) {
      const p = parseKey(next)
      dfs(
        next,
        [
          ...path,
          {
            nodeId: p.nodeId,
            column: p.column,
            transformation: xform,
            expression,
          },
        ],
        hitFocus || next === focusK,
      )
    }
  }

  for (const r of roots.length ? roots : [focusK]) {
    const p = parseKey(r)
    dfs(r, [{ nodeId: p.nodeId, column: p.column }], r === focusK)
  }

  if (best) return best

  // Fallback: just list focus
  return [{ nodeId: focusNode, column: focusCol }]
}

/** Immediate downstream consumers of a column within column_lineage. */
export function collectColumnDownstream(
  lineage: SqlGraphColumnLineage | undefined,
  nodeId: string,
  column: string,
): { nodeId: string; column: string; transformation?: SqlGraphColumnDep['transformation'] }[] {
  if (!lineage) return []
  const out: { nodeId: string; column: string; transformation?: SqlGraphColumnDep['transformation'] }[] = []
  const seen = new Set<string>()
  for (const [tid, cols] of Object.entries(lineage)) {
    for (const [tcol, deps] of Object.entries(cols)) {
      for (const dep of deps) {
        if (dep.source_node !== nodeId || dep.source_column !== column) continue
        const k = colKey(tid, tcol)
        if (seen.has(k)) continue
        seen.add(k)
        out.push({ nodeId: tid, column: tcol, transformation: dep.transformation })
      }
    }
  }
  return out
}

export interface ColumnUpstreamHop {
  nodeId: string
  column: string
  transformation?: SqlGraphColumnDep['transformation']
  expression?: string
}

/**
 * Recursive upstream hops for the CTE detail panel (nearest first).
 * Unlike direct deps, this walks through passthrough CTEs to parents/sources.
 */
export function collectColumnUpstream(
  lineage: SqlGraphColumnLineage | undefined,
  nodeId: string,
  column: string,
): ColumnUpstreamHop[] {
  if (!lineage) return []
  const out: ColumnUpstreamHop[] = []
  const seen = new Set<string>()
  const queue: { nodeId: string; column: string }[] = [{ nodeId, column }]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]!
    const deps = lineage[cur.nodeId]?.[cur.column]
    if (!deps?.length) continue
    for (const dep of deps) {
      if (!dep.source_node || !dep.source_column) continue
      const k = colKey(dep.source_node, dep.source_column)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({
        nodeId: dep.source_node,
        column: dep.source_column,
        transformation: dep.transformation,
        expression: dep.expression,
      })
      queue.push({ nodeId: dep.source_node, column: dep.source_column })
    }
  }
  return out
}
