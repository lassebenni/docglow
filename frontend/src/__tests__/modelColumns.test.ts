import { describe, expect, it } from 'vitest'
import { buildModelColumnsMap } from '../utils/modelColumns'
import type { DocglowData } from '../types'

describe('buildModelColumnsMap', () => {
  it('includes exposure columns when present', () => {
    const data = {
      models: {
        'model.x.orders': {
          columns: [{ name: 'id' }],
        },
      },
      sources: {},
      exposures: {
        'exposure.x.dash': {
          columns: [{ name: 'Netto Omzet' }],
        },
      },
    } as unknown as DocglowData

    const map = buildModelColumnsMap(data)
    expect(map['model.x.orders']).toEqual(['id'])
    expect(map['exposure.x.dash']).toEqual(['Netto Omzet'])
  })

  it('skips exposures without columns', () => {
    const data = {
      models: {},
      sources: {},
      exposures: {
        'exposure.x.empty': {
          columns: [],
        },
      },
    } as unknown as DocglowData

    const map = buildModelColumnsMap(data)
    expect(map['exposure.x.empty']).toBeUndefined()
  })
})
