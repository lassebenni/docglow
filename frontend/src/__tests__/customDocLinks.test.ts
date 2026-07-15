import { describe, expect, it } from 'vitest'
import { resolveCustomDocLink } from '../utils/customDocLinks'
import type { CustomDoc } from '../types'

const docs: readonly CustomDoc[] = [
  {
    slug: 'guide',
    label: 'Guide',
    url: 'docs/exp_saleplanner_item_series_daily/guide.html',
    source_file: 'docs/concepts/saleplanner/exp_saleplanner_item_series.html',
  },
  {
    slug: 'workbook',
    label: 'Workbook',
    url: 'docs/exp_saleplanner_item_series_daily/workbook.html',
    source_file: 'analyses/saleplanner/2026_07_08_saleplanner__marts.html',
  },
]

describe('resolveCustomDocLink', () => {
  it('resolves slug-only cross-doc links', () => {
    expect(resolveCustomDocLink('guide#step-1', 'workbook', docs)).toEqual({
      slug: 'guide',
      anchor: 'step-1',
    })
    expect(resolveCustomDocLink('workbook#cte-sku_bridge', 'guide', docs)).toEqual({
      slug: 'workbook',
      anchor: 'cte-sku_bridge',
    })
  })

  it('resolves self alias to guide', () => {
    expect(resolveCustomDocLink('self#overview', 'workbook', docs)).toEqual({
      slug: 'guide',
      anchor: 'overview',
    })
  })

  it('resolves same-page fragment links', () => {
    expect(resolveCustomDocLink('#cte-sales_measures_check', 'workbook', docs)).toEqual({
      slug: 'workbook',
      anchor: 'cte-sales_measures_check',
    })
  })

  it('resolves sibling html links', () => {
    expect(resolveCustomDocLink('guide.html#step-1', 'workbook', docs)).toEqual({
      slug: 'guide',
      anchor: 'step-1',
    })
    expect(resolveCustomDocLink('./workbook.html', 'guide', docs)).toEqual({
      slug: 'workbook',
      anchor: '',
    })
  })

  it('resolves site-relative copied doc paths', () => {
    expect(
      resolveCustomDocLink(
        'docs/exp_saleplanner_item_series_daily/workbook.html#cte-snapshot_freshness_check',
        'guide',
        docs,
      ),
    ).toEqual({
      slug: 'workbook',
      anchor: 'cte-snapshot_freshness_check',
    })
  })

  it('resolves repo-relative source paths by source_file basename', () => {
    expect(
      resolveCustomDocLink(
        '../../../analyses/saleplanner/2026_07_08_saleplanner__marts.html#cte-snapshot_freshness_check',
        'guide',
        docs,
      ),
    ).toEqual({
      slug: 'workbook',
      anchor: 'cte-snapshot_freshness_check',
    })
    expect(
      resolveCustomDocLink(
        '../../docs/concepts/saleplanner/exp_saleplanner_item_series.html',
        'workbook',
        docs,
      ),
    ).toEqual({
      slug: 'guide',
      anchor: '',
    })
  })

  it('returns null for external and unknown links', () => {
    expect(resolveCustomDocLink('https://example.com', 'guide', docs)).toBeNull()
    expect(resolveCustomDocLink('other.html', 'guide', docs)).toBeNull()
    expect(resolveCustomDocLink('unknown#anchor', 'guide', docs)).toBeNull()
  })
})
