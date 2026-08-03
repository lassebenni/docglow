import { describe, expect, it } from 'vitest'
import type { ColumnLineageDependency } from '../types'
import {
  columnExpression,
  columnKindMapForModel,
  strongestTransformation,
  transformationGlyph,
  transformationLabel,
  upstreamSourceDeps,
} from '../utils/columnTransforms'

function dep(
  transformation: ColumnLineageDependency['transformation'],
  expression?: string,
  source?: { model: string; column: string },
): ColumnLineageDependency {
  return {
    ...(source
      ? { source_model: source.model, source_column: source.column }
      : {}),
    transformation,
    ...(expression ? { expression } : {}),
  }
}

describe('columnTransforms', () => {
  it('maps glyphs for ambient scan', () => {
    expect(transformationGlyph('passthrough')).toBe('→')
    expect(transformationGlyph('rename')).toBe('→')
    expect(transformationGlyph('derived')).toBe('ƒ')
    expect(transformationGlyph('aggregated')).toBe('Σ')
    expect(transformationGlyph('constant')).toBe('LIT')
    expect(transformationGlyph('untraced')).toBe('?')
    expect(transformationGlyph('unknown')).toBeNull()
  })

  it('picks strongest transformation across deps', () => {
    expect(strongestTransformation([dep('passthrough'), dep('derived')])).toBe('derived')
    expect(strongestTransformation([dep('derived'), dep('aggregated')])).toBe('aggregated')
    expect(strongestTransformation([dep('constant', 'NULL')])).toBe('constant')
  })

  it('returns defining expression for derived and constant deps', () => {
    expect(
      columnExpression([
        dep('passthrough', undefined, { model: 'm', column: 'c' }),
        dep('derived', "COALESCE(type = 'jaffle', FALSE)", { model: 'm', column: 'type' }),
      ]),
    ).toBe("COALESCE(type = 'jaffle', FALSE)")
    expect(columnExpression([dep('constant', 'NULL')])).toBe('NULL')
    expect(columnExpression([dep('rename')])).toBeNull()
  })

  it('filters upstream source deps', () => {
    const deps = [
      dep('constant', 'NULL'),
      dep('rename', undefined, { model: 'model.src', column: 'id' }),
    ]
    expect(upstreamSourceDeps(deps)).toHaveLength(1)
    expect(upstreamSourceDeps(deps)[0]?.source_column).toBe('id')
  })

  it('builds per-model kind map including constant/untraced', () => {
    const map = columnKindMapForModel(
      {
        'model.orders': {
          order_id: [dep('rename', undefined, { model: 's', column: 'id' })],
          tax_paid: [dep('constant', 'NULL')],
          weird: [dep('untraced')],
        },
      },
      'model.orders',
    )
    expect(map?.get('order_id')).toBe('rename')
    expect(map?.get('tax_paid')).toBe('constant')
    expect(map?.get('weird')).toBe('untraced')
    expect(transformationLabel('constant')).toBe('Constant')
    expect(transformationLabel('untraced')).toBe('Untraced')
  })
})
