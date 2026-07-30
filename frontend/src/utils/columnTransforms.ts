import { TRANSFORMATION_STRENGTH, type TransformationType } from '@docglow/shared-types'
import type { ColumnLineageDependency, ColumnLineageData } from '../types'

const PRIORITY: Record<TransformationType, number> = Object.fromEntries(
  TRANSFORMATION_STRENGTH.map((kind, i) => [kind, i]),
) as Record<TransformationType, number>

/** Ambient glyph for a column's transformation kind. */
export function transformationGlyph(kind: TransformationType | null | undefined): string | null {
  if (!kind || kind === 'unknown' || kind === 'direct') return null
  if (kind === 'passthrough' || kind === 'rename') return '→'
  if (kind === 'aggregated') return 'Σ'
  if (kind === 'constant') return '·'
  if (kind === 'untraced') return '?'
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
    case 'constant':
      return 'Constant'
    case 'untraced':
      return 'Untraced'
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

/** First defining SQL expression among derived/aggregated/constant deps. */
export function columnExpression(
  deps: readonly ColumnLineageDependency[] | null | undefined,
): string | null {
  if (!deps) return null
  for (const dep of deps) {
    if (
      dep.expression
      && (
        dep.transformation === 'derived'
        || dep.transformation === 'aggregated'
        || dep.transformation === 'constant'
      )
    ) {
      return dep.expression
    }
  }
  return null
}

/** Upstream deps that have a resolvable source model (excludes constant/untraced). */
export function upstreamSourceDeps(
  deps: readonly ColumnLineageDependency[] | null | undefined,
): ColumnLineageDependency[] {
  if (!deps) return []
  return deps.filter(d => Boolean(d.source_model && d.source_column))
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
