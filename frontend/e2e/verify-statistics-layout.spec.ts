import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const baseFixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8'),
) as Record<string, unknown>

const modelId = 'model.vantilburg_dwh.exp_saleplanner_item_series_daily'
const modelUrl = `/#/model/${modelId}/statistics`

const unitsSoldProfile = {
  row_count: 2706042,
  null_count: 0,
  null_rate: 0,
  distinct_count: 14,
  distinct_rate: 0.00001,
  is_unique: false,
  min: 0,
  max: 13,
  mean: 0.12,
  median: 0,
  stddev: 0.8,
  top_values: [
    { value: '0', frequency: 2501216 },
    { value: '1', frequency: 154824 },
    { value: '2', frequency: 27082 },
    { value: '3', frequency: 6545 },
    { value: '4', frequency: 2136 },
  ],
  histogram: [
    { low: 0, high: 1.3, count: 2501216 },
    { low: 1.3, high: 2.6, count: 154824 },
    { low: 2.6, high: 3.9, count: 27082 },
    { low: 3.9, high: 5.2, count: 6545 },
    { low: 5.2, high: 6.5, count: 2136 },
    { low: 6.5, high: 7.8, count: 890 },
    { low: 7.8, high: 9.1, count: 412 },
    { low: 9.1, high: 10.4, count: 201 },
    { low: 10.4, high: 11.7, count: 98 },
    { low: 11.7, high: 13, count: 638 },
  ],
}

const unitsReturnedProfile = {
  row_count: 2706042,
  null_count: 0,
  null_rate: 0,
  distinct_count: 19,
  distinct_rate: 0.00001,
  is_unique: false,
  min: -18,
  max: 0,
  mean: -0.4,
  median: -0.9,
  stddev: 1.2,
  top_values: [
    { value: '0', frequency: 2650000 },
    { value: '-1', frequency: 42000 },
    { value: '-2', frequency: 8500 },
    { value: '-18', frequency: 17 },
  ],
  histogram: [
    { low: -18, high: -16.2, count: 17 },
    { low: -16.2, high: -14.4, count: 3 },
    { low: -14.4, high: -12.6, count: 1 },
    { low: -12.6, high: -10.8, count: 0 },
    { low: -10.8, high: -9, count: 2 },
    { low: -9, high: -7.2, count: 5 },
    { low: -7.2, high: -5.4, count: 8 },
    { low: -5.4, high: -3.6, count: 120 },
    { low: -3.6, high: -1.8, count: 12486 },
    { low: -1.8, high: 0, count: 2692400 },
  ],
}

function buildVerifyData() {
  const data = structuredClone(baseFixture) as {
    metadata: { project_name: string }
    models: Record<string, Record<string, unknown>>
    lineage: { nodes: Array<Record<string, unknown>> }
  }

  data.metadata.project_name = 'vantilburg_dwh'
  data.models[modelId] = {
    unique_id: modelId,
    name: 'exp_saleplanner_item_series_daily',
    description: 'Verification fixture for statistics tab layout',
    schema: 'dwh',
    database: 'vantilburg',
    materialization: 'table',
    tags: [],
    meta: {},
    path: 'models/exp_saleplanner_item_series_daily.sql',
    folder: 'models',
    raw_sql: 'select 1',
    compiled_sql: 'select 1',
    columns: [
      {
        name: 'units_sold',
        description: '',
        data_type: 'INTEGER',
        meta: {},
        tags: [],
        tests: [],
        profile: unitsSoldProfile,
      },
      {
        name: 'units_returned',
        description: '',
        data_type: 'INTEGER',
        meta: {},
        tags: [],
        tests: [],
        profile: unitsReturnedProfile,
      },
    ],
    depends_on: [],
    referenced_by: [],
    sources_used: [],
    test_results: [],
    last_run: null,
    catalog_stats: { row_count: 2706042, bytes: 104857600, has_stats: true },
    profiling: {
      profiled_row_count: 2706042,
      total_row_count: 2706042,
      is_sampled: false,
      sample_size: null,
    },
  }

  data.lineage.nodes.push({
    id: modelId,
    name: 'exp_saleplanner_item_series_daily',
    resource_type: 'model',
    materialization: 'table',
    schema: 'dwh',
    test_status: 'none',
    has_description: true,
    folder: 'models',
    tags: [],
    layer: 3,
    layer_auto: false,
  })

  return data
}

test.describe('Statistics layout verification', () => {
  test.beforeEach(async ({ page }) => {
    const verifyData = buildVerifyData()
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(verifyData),
      })
    })
    await page.goto(modelUrl)
    await page.waitForSelector('h1:has-text("exp_saleplanner_item_series_daily")')
  })

  test('top values show count and percent without overlap', async ({ page }) => {
    const main = page.locator('main')
    await expect(main.getByText('Value Distributions (Numeric)')).toBeVisible()

    const statsText = main.locator('span.tabular-nums').filter({ hasText: '2,501,216' }).first()
    await expect(statsText).toBeVisible()
    await expect(statsText).toContainText('92.4%')

    const box = await statsText.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.width).toBeGreaterThan(100)
    }
  })

  test('value distributions show exact record counts per value', async ({ page }) => {
    const main = page.locator('main')
    await expect(main.getByText('Value Distributions (Numeric)')).toBeVisible()

    const returnedCard = main
      .locator('span.font-mono.font-medium', { hasText: 'units_returned' })
      .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    const minRow = returnedCard.locator('tr').filter({ hasText: 'Min' })
    await expect(minRow).toContainText('-18')
    await expect(minRow).toContainText('17')

    const medianRow = returnedCard.locator('tr').filter({ hasText: 'Median' })
    await expect(medianRow).toContainText('0')
    await expect(medianRow).toContainText('2,650,000')
    await expect(medianRow).not.toContainText('2,692,400')

    const maxRow = returnedCard.locator('tr').filter({ hasText: 'Max' })
    await expect(maxRow).toContainText('0')
    await expect(maxRow).toContainText('2,650,000')
  })
})
