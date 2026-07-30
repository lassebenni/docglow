import type { SqlGraphColumnDep, SqlGraphColumnLineage } from '../types'

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
  /** Upstream roots → selected column (ordered for the panel) */
  steps: ColumnPathStep[]
  keys: Set<string>
  /** Structure edges that carry the path: `${source}\0${target}` */
  edgeKeys: Set<string>
}

/**
 * Trace a column through sql_graph.column_lineage **upstream only**
 * (selected field + every column it depends on, recursively).
 * Downstream consumers and same-node sibling passthroughs are not highlighted.
 */
export function collectColumnPath(
  lineage: SqlGraphColumnLineage | undefined,
  nodeId: string,
  column: string,
): ColumnPathResult {
  const keys = new Set<string>()
  const edgeKeys = new Set<string>()
  if (!lineage) {
    keys.add(colKey(nodeId, column))
    return { steps: [{ nodeId, column }], keys, edgeKeys }
  }
  const graphLineage = lineage

  // Walk upstream (DFS), build parent map
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
      if (!dep.source_node) continue
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

  const steps = orderPathSteps(nodeId, column, links, keys)
  return { steps, keys, edgeKeys }
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
