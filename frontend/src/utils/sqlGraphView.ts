import type { SqlGraph, SqlGraphAggFn, SqlGraphNode } from '../types'

/** Collapse pure passthrough CTEs by rewiring neighbors A→passthrough→B into A→B. */
export function collapsePassthroughCtes(graph: SqlGraph): SqlGraph {
  const passthroughIds = new Set(
    graph.nodes.filter(n => n.kind === 'cte' && n.passthrough).map(n => n.id),
  )
  if (passthroughIds.size === 0) return graph

  const nodes = graph.nodes.filter(n => !passthroughIds.has(n.id))
  const edges: { source: string; target: string; label?: string; columns?: readonly string[] }[] = []
  const seen = new Set<string>()

  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    incoming.get(e.target)!.push(e.source)
    outgoing.get(e.source)!.push(e.target)
  }

  function resolveUpstream(id: string, visited: Set<string> = new Set()): string[] {
    if (!passthroughIds.has(id)) return [id]
    if (visited.has(id)) return []
    visited.add(id)
    const parents = incoming.get(id) ?? []
    return parents.flatMap(p => resolveUpstream(p, visited))
  }

  function resolveDownstream(id: string, visited: Set<string> = new Set()): string[] {
    if (!passthroughIds.has(id)) return [id]
    if (visited.has(id)) return []
    visited.add(id)
    const kids = outgoing.get(id) ?? []
    return kids.flatMap(k => resolveDownstream(k, visited))
  }

  for (const e of graph.edges) {
    if (passthroughIds.has(e.source) || passthroughIds.has(e.target)) continue
    const key = `${e.source}\0${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: e.source, target: e.target, label: e.label, columns: e.columns })
  }

  // Bridge across collapsed passthrough chains
  for (const pid of passthroughIds) {
    const ups = resolveUpstream(pid)
    const downs = resolveDownstream(pid)
    for (const u of ups) {
      for (const d of downs) {
        if (u === d || passthroughIds.has(u) || passthroughIds.has(d)) continue
        const key = `${u}\0${d}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source: u, target: d })
      }
    }
  }

  return {
    ...graph,
    nodes,
    edges,
  }
}

/** Join-key column names + neighboring node ids for a join node. */
export function joinHighlightFromNode(
  graph: SqlGraph,
  joinNode: SqlGraphNode,
): { columns: Set<string>; nodeIds: Set<string> } | null {
  if (joinNode.kind !== 'join' || !joinNode.join_keys?.length) return null
  const columns = new Set<string>()
  for (const k of joinNode.join_keys) {
    columns.add(k.left_column)
    columns.add(k.right_column)
  }
  const nodeIds = new Set<string>([joinNode.id])
  for (const e of graph.edges) {
    if (e.source === joinNode.id) nodeIds.add(e.target)
    if (e.target === joinNode.id) nodeIds.add(e.source)
  }
  return { columns, nodeIds }
}

const AGG_GLYPH: Record<SqlGraphAggFn, string> = {
  sum: 'SUM',
  count: 'CNT',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
  group: 'GRP',
  none: '',
}

/** Short glyph for aggregate CTE columns (SUM / CNT / GRP). */
export function aggFnGlyph(fn: SqlGraphAggFn | null | undefined): string | null {
  if (!fn || fn === 'none') return null
  return AGG_GLYPH[fn] ?? fn.toUpperCase()
}

export function aggFnLabel(fn: SqlGraphAggFn | null | undefined): string | null {
  if (!fn || fn === 'none') return null
  if (fn === 'group') return 'Group key'
  if (fn === 'count') return 'Count'
  return fn.charAt(0).toUpperCase() + fn.slice(1)
}

/** Split select_sql into lines and mark the line defining ``column``. */
export function highlightSelectSqlLines(
  sql: string,
  column: string,
): { text: string; highlight: boolean }[] {
  const lines = sql.replace(/\r\n/g, '\n').split('\n')
  const col = column.toLowerCase()
  const asRe = new RegExp(`\\bas\\s+["\`]?${escapeRegExp(col)}["\`]?\\b`, 'i')
  const bareRe = new RegExp(
    `(^|[\\s,(])["\`]?${escapeRegExp(col)}["\`]?(\\s*[,)]|\\s*$)`,
    'i',
  )
  return lines.map(text => {
    const trimmed = text.trim()
    if (!trimmed) return { text, highlight: false }
    const highlight =
      asRe.test(trimmed)
      || (bareRe.test(trimmed) && !/\b(from|group|order|where|having)\b/i.test(trimmed))
    return { text, highlight }
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
