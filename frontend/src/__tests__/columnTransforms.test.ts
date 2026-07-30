import { describe, expect, it } from 'vitest'
import type { ColumnLineageDependency } from '../types'
import {
  columnExpression,
  columnKindMapForModel,
  strongestTransformation,
  transformationGlyph,
  transformationLabel,
} from '../utils/columnTransforms'

function dep(
  transformation: ColumnLineageDependency['transformation'],
  expression?: string,
): ColumnLineageDependency {
  return {
    source_model: 'model.src',
    source_column: 'type',
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
    expect(transformationGlyph('unknown')).toBeNull()
  })

  it('picks strongest transformation across deps', () => {
    expect(strongestTransformation([dep('passthrough'), dep('derived')])).toBe('derived')
    expect(strongestTransformation([dep('derived'), dep('aggregated')])).toBe('aggregated')
  })

  it('returns defining expression for derived deps', () => {
    const deps = [
      dep('passthrough'),
      dep('derived', "COALESCE(type = 'jaffle', FALSE)"),
    ]
    expect(columnExpression(deps)).toBe("COALESCE(type = 'jaffle', FALSE)")
    expect(columnExpression([dep('rename')])).toBeNull()
  })

  it('builds per-model kind map', () => {
    const map = columnKindMapForModel(
      {
        'model.products': {
          product_id: [dep('rename')],
          is_food_item: [dep('derived', '1 = 1')],
        },
      },
      'model.products',
    )
    expect(map?.get('product_id')).toBe('rename')
    expect(map?.get('is_food_item')).toBe('derived')
    expect(transformationLabel('derived')).toBe('Derived')
  })
})
