/**
 * Resolve Power BI / DAX measure references in a formula to warehouse columns.
 *
 * Composite measures often look like:
 *   [Artikelnetto-omzet excl. BTW] + [Dienstenomzet excl. BTW] - [Bonkortingsbedrag]
 *
 * With a map of measure → ["fct_sales_txn_line.amt_sales_excl_vat", ...], this
 * rewrites bracketed measure names to English model.column refs so the side
 * panel can show both the authentic DAX and a resolved lineage formula.
 */

/** Bracketed measure refs: [Netto Omzet excl. BTW] */
const MEASURE_REF_RE = /\[([^\]]+)\]/g

export interface FormulaLeafSource {
  /** Dutch / PBI measure name as it appears in the formula. */
  measureName: string
  sourceModel: string
  sourceColumn: string
}

/**
 * Ordered unique leaf measures referenced in a formula (``[Measure]``), each
 * mapped to its warehouse column. Composites (multiple columns) are skipped —
 * their body usually already lists the leaf measures inline.
 *
 * This is why "From" can list more rows than unique model.column pairs: several
 * measures (e.g. Stickerkorting vs Bonkorting) share one mart column with
 * different DAX filters.
 */
export function extractFormulaLeafSources(
  expression: string,
  fieldLineage: Readonly<
    Record<string, readonly { source_model?: string; source_column?: string }[]>
  >,
): FormulaLeafSource[] {
  if (!expression.trim()) return []

  const out: FormulaLeafSource[] = []
  const seenMeasure = new Set<string>()
  const re = new RegExp(MEASURE_REF_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(expression)) !== null) {
    const measureName = match[1]!
    if (seenMeasure.has(measureName)) continue
    seenMeasure.add(measureName)

    const deps = fieldLineage[measureName]
    if (!deps) continue
    const leaves: FormulaLeafSource[] = []
    const seenCol = new Set<string>()
    for (const dep of deps) {
      if (!dep.source_model || !dep.source_column) continue
      const key = `${dep.source_model}\0${dep.source_column}`
      if (seenCol.has(key)) continue
      seenCol.add(key)
      leaves.push({
        measureName,
        sourceModel: dep.source_model,
        sourceColumn: dep.source_column,
      })
    }
    // Leaf = exactly one warehouse column; composites stay out of From.
    if (leaves.length === 1) out.push(leaves[0]!)
  }
  return out
}

export interface GroupedFormulaSource {
  sourceModel: string
  sourceColumn: string
  measureNames: string[]
}

/** Collapse leaf measures that share the same warehouse column. */
export function groupFormulaSourcesByColumn(
  sources: readonly FormulaLeafSource[],
): GroupedFormulaSource[] {
  const order: string[] = []
  const map = new Map<string, GroupedFormulaSource>()
  for (const src of sources) {
    const key = `${src.sourceModel}\0${src.sourceColumn}`
    const existing = map.get(key)
    if (existing) {
      if (!existing.measureNames.includes(src.measureName)) {
        existing.measureNames.push(src.measureName)
      }
    } else {
      order.push(key)
      map.set(key, {
        sourceModel: src.sourceModel,
        sourceColumn: src.sourceColumn,
        measureNames: [src.measureName],
      })
    }
  }
  return order.map((k) => map.get(k)!)
}

/**
 * Rewrite leaf measure refs to ``model.column``. Multi-column (composite)
 * measures are left as ``[Measure]`` so parent operators stay meaningful —
 * expanding them as ``(a + b + c)`` loses minus signs and double-counts
 * when the formula already inlines the composite body.
 */
export function resolveMeasureRefsInFormula(
  expression: string,
  measureToColumns: Readonly<Record<string, readonly string[]>>,
): string | null {
  if (!expression.trim()) return null

  let replaced = 0
  const resolved = expression.replace(MEASURE_REF_RE, (match, measureName: string) => {
    const cols = measureToColumns[measureName]
    if (!cols || cols.length === 0) return match
    // Leaf measures only — one warehouse column.
    if (cols.length !== 1) return match
    replaced += 1
    return cols[0]!
  })

  if (replaced === 0) return null
  return resolved
}

/** Build measure-name → "model.column" list from one resource's column_lineage map. */
export function buildMeasureColumnMap(
  fieldLineage: Readonly<Record<string, readonly { source_model?: string; source_column?: string }[]>>,
  nameOf: (modelId: string) => string,
): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const [fieldName, deps] of Object.entries(fieldLineage)) {
    const cols: string[] = []
    const seen = new Set<string>()
    for (const dep of deps) {
      if (!dep.source_model || !dep.source_column) continue
      const label = `${nameOf(dep.source_model)}.${dep.source_column}`
      if (seen.has(label)) continue
      seen.add(label)
      cols.push(label)
    }
    if (cols.length > 0) map[fieldName] = cols
  }
  return map
}
