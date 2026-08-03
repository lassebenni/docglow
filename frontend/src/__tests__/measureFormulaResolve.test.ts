import { describe, expect, it } from 'vitest'
import {
  buildMeasureColumnMap,
  extractFormulaLeafSources,
  groupFormulaSourcesByColumn,
  resolveMeasureRefsInFormula,
} from '../utils/measureFormulaResolve'

describe('resolveMeasureRefsInFormula', () => {
  const map = {
    'Artikelnetto-omzet excl. BTW': ['fct_sales_txn_line.amt_sales_excl_vat'],
    'Dienstenomzet excl. BTW': ['agg_sales_txn_line_by_document.amt_service_sales_excl_vat'],
    'Bonkortingsbedrag': ['fct_sales_txn_line.amt_discount_excl_vat'],
  }

  it('rewrites Dutch measure refs to English model.column', () => {
    const dax =
      'Netto Omzet (Default) excl. BTW\n  = [Artikelnetto-omzet excl. BTW]\n    + [Dienstenomzet excl. BTW]\n    - [Bonkortingsbedrag]'
    const resolved = resolveMeasureRefsInFormula(dax, map)
    expect(resolved).toContain('fct_sales_txn_line.amt_sales_excl_vat')
    expect(resolved).toContain('agg_sales_txn_line_by_document.amt_service_sales_excl_vat')
    expect(resolved).toContain('fct_sales_txn_line.amt_discount_excl_vat')
    expect(resolved).not.toContain('[Artikelnetto')
  })

  it('returns null when there are no measure refs', () => {
    expect(
      resolveMeasureRefsInFormula(
        'CALCULATE(SUM(fct_sales_txn_line[amt_sales_excl_vat]))',
        map,
      ),
    ).toBeNull()
  })

  it('keeps unknown measure refs unchanged and still returns when some resolve', () => {
    const resolved = resolveMeasureRefsInFormula(
      '[Artikelnetto-omzet excl. BTW] + [Unknown Measure]',
      map,
    )
    expect(resolved).toBe(
      'fct_sales_txn_line.amt_sales_excl_vat + [Unknown Measure]',
    )
  })

  it('leaves multi-column composite measures as [Measure] refs', () => {
    const multi = {
      'Revenue + Orders': ['orders.order_total', 'orders.order_id'],
      'Artikelnetto-omzet excl. BTW': ['fct.amt_sales'],
    }
    expect(
      resolveMeasureRefsInFormula(
        '[Revenue + Orders] + [Artikelnetto-omzet excl. BTW]',
        multi,
      ),
    ).toBe('[Revenue + Orders] + fct.amt_sales')
  })
})

describe('extractFormulaLeafSources', () => {
  const lineage = {
    'Artikelnetto-omzet excl. BTW': [
      { source_model: 'model.x.fct', source_column: 'amt_sales_excl_vat' },
    ],
    'Dienstenomzet excl. BTW': [
      { source_model: 'model.x.agg', source_column: 'amt_service_sales_excl_vat' },
    ],
    'Bonkortingsbedrag': [
      { source_model: 'model.x.fct', source_column: 'amt_discount_excl_vat' },
    ],
    'Stickerkortingsbedrag': [
      { source_model: 'model.x.fct', source_column: 'amt_discount_excl_vat' },
    ],
    'Netto Omzet (Default) excl. BTW': [
      { source_model: 'model.x.fct', source_column: 'amt_sales_excl_vat' },
      { source_model: 'model.x.agg', source_column: 'amt_service_sales_excl_vat' },
      { source_model: 'model.x.fct', source_column: 'amt_discount_excl_vat' },
    ],
  }

  it('lists each leaf measure even when warehouse columns repeat', () => {
    const expr = `
      [Netto Omzet (Default) excl. BTW]
        = [Artikelnetto-omzet excl. BTW] + [Dienstenomzet excl. BTW] − [Bonkortingsbedrag]
      SWITCH("KORT_STICKER", −[Stickerkortingsbedrag])
    `
    const leaves = extractFormulaLeafSources(expr, lineage)
    expect(leaves.map((l) => l.measureName)).toEqual([
      'Artikelnetto-omzet excl. BTW',
      'Dienstenomzet excl. BTW',
      'Bonkortingsbedrag',
      'Stickerkortingsbedrag',
    ])
    expect(leaves.filter((l) => l.sourceColumn === 'amt_discount_excl_vat')).toHaveLength(2)
  })

  it('skips composite measure refs', () => {
    const leaves = extractFormulaLeafSources(
      '[Netto Omzet (Default) excl. BTW] + [Artikelnetto-omzet excl. BTW]',
      lineage,
    )
    expect(leaves.map((l) => l.measureName)).toEqual(['Artikelnetto-omzet excl. BTW'])
  })
})

describe('groupFormulaSourcesByColumn', () => {
  it('merges measures that share a warehouse column', () => {
    const grouped = groupFormulaSourcesByColumn([
      {
        measureName: 'Bonkortingsbedrag',
        sourceModel: 'model.x.fct',
        sourceColumn: 'amt_discount_excl_vat',
      },
      {
        measureName: 'Stickerkortingsbedrag',
        sourceModel: 'model.x.fct',
        sourceColumn: 'amt_discount_excl_vat',
      },
      {
        measureName: 'Artikelnetto-omzet excl. BTW',
        sourceModel: 'model.x.fct',
        sourceColumn: 'amt_sales_excl_vat',
      },
    ])
    expect(grouped).toHaveLength(2)
    const discount = grouped.find((g) => g.sourceColumn === 'amt_discount_excl_vat')
    expect(discount?.measureNames).toEqual([
      'Bonkortingsbedrag',
      'Stickerkortingsbedrag',
    ])
  })
})

describe('buildMeasureColumnMap', () => {
  it('maps field names to model.column labels', () => {
    const map = buildMeasureColumnMap(
      {
        'Artikelnetto-omzet excl. BTW': [
          {
            source_model: 'model.x.fct_sales_txn_line',
            source_column: 'amt_sales_excl_vat',
          },
        ],
      },
      (id) => id.split('.').pop()!,
    )
    expect(map['Artikelnetto-omzet excl. BTW']).toEqual([
      'fct_sales_txn_line.amt_sales_excl_vat',
    ])
  })
})
