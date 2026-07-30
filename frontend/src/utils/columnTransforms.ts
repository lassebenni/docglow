import type { ColumnLineageDependency, ColumnLineageData, TransformationType } from '../types'

const PRIORITY: Record<TransformationType, number> = {
  unknown: 0,
  direct: 1,
  passthrough: 2,
  rename: 3,
  derived: 4,
  aggregated: 5,
}

/** Ambient glyph for a column's transformation kind. */
export function transformationGlyph(kind: TransformationType | null | undefined): string | null {
  if (!kind || kind === 'unknown' || kind === 'direct') return null
  if (kind === 'passthrough' || kind === 'rename') return '→'
  if (kind === 'aggregated') return 'Σ'
  return 'ƒ'
}

export function transformationLabel(kind: TransformationType | null | undefined): string {
  switch (kind) {
    case 'passthrough':
      return 'Passthrough'
    case 'rename':
      return 'Rename'
    case 'derived':
      return 'Derived'
    case 'aggregated':
      return 'Aggregated'
    case 'direct':
      return 'Passthrough'
    default:
      return 'Unknown'
  }
}

/** Strongest transformation among a column's upstream deps. */
export function strongestTransformation(
  deps: readonly ColumnLineageDependency[] | null | undefined,
): TransformationType | null {
  if (!deps || deps.length === 0) return null
  let best: TransformationType = deps[0]!.transformation
  let bestPri = PRIORITY[best] ?? 0
  for (let i = 1; i < deps.length; i++) {
    const kind = deps[i]!.transformation
    const pri = PRIORITY[kind] ?? 0
    if (pri > bestPri) {
      best = kind
      bestPri = pri
    }
  }
  return best
}

/** First defining SQL expression among derived/aggregated deps. */
export function columnExpression(
  deps: readonly ColumnLineageDependency[] | null | undefined,
): string | null {
  if (!deps) return null
  for (const dep of deps) {
    if (
      dep.expression
      && (dep.transformation === 'derived' || dep.transformation === 'aggregated')
    ) {
      return dep.expression
    }
  }
  return null
}

/** Per-column transformation kinds for a model (ambient glyphs). */
export function columnKindMapForModel(
  columnLineage: ColumnLineageData | null | undefined,
  modelId: string,
): Map<string, TransformationType> | undefined {
  const cols = columnLineage?.[modelId]
  if (!cols) return undefined
  const map = new Map<string, TransformationType>()
  for (const [col, deps] of Object.entries(cols)) {
    const kind = strongestTransformation(deps)
    if (kind) map.set(col, kind)
  }
  return map.size > 0 ? map : undefined
}
