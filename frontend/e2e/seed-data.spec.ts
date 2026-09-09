import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const repoRoot = path.join(fixturesDir, '../../..')
const baseFixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8'),
) as Record<string, unknown>

const SEED_ID = 'seed.vantilburg_dwh.seed_dim_web_shop'

function buildFixtureData(): string {
  const data = structuredClone(baseFixture) as {
    seeds: Record<string, unknown>
    models: Record<string, unknown>
    lineage: { nodes: Array<{ id: string }> }
  }

  data.seeds = {
    [SEED_ID]: {
      unique_id: SEED_ID,
      name: 'seed_dim_web_shop',
      description: '',
      schema: 'dbt_prod_seeds',
      database: 'vantilburg_dwh',
      materialization: 'seed',
      tags: [],
      meta: {},
      path: 'seeds/seed_dim_web_shop.csv',
      folder: 'seeds',
      raw_sql: '',
      compiled_sql: '',
      columns: [
        { name: 'domain', description: '', data_type: '', meta: {}, tags: [], tests: [], profile: null },
        { name: 'web_shop_code', description: '', data_type: '', meta: {}, tags: [], tests: [], profile: null },
        { name: 'web_shop_name', description: '', data_type: '', meta: {}, tags: [], tests: [], profile: null },
      ],
      depends_on: [],
      referenced_by: ['model.vantilburg_dwh.dim_web_shop'],
      sources_used: [],
      test_results: [],
      last_run: null,
      catalog_stats: { row_count: null, bytes: null, has_stats: false },
      sample_data: {
        schema: 'dbt_prod_seeds',
        table: 'seed_dim_web_shop',
        columns: ['domain', 'web_shop_code', 'web_shop_name'],
        rows: [
          ['vantilburg.nl', 'VT01', 'Van Tilburg NL'],
          ['example.com', 'EX02', 'Example Shop'],
        ],
        row_count: 2,
        limit: 1000,
        generated_at: '2026-03-09T08:00:00Z',
        all_columns: ['domain', 'web_shop_code', 'web_shop_name'],
      },
    },
  }

  data.models['model.vantilburg_dwh.dim_web_shop'] = {
    unique_id: 'model.vantilburg_dwh.dim_web_shop',
    name: 'dim_web_shop',
    description: '',
    schema: 'dbt_prod',
    database: 'vantilburg_dwh',
    materialization: 'table',
    tags: [],
    meta: {},
    path: 'models/marts/dim_web_shop.sql',
    folder: 'models/marts',
    raw_sql: 'select * from {{ ref("seed_dim_web_shop") }}',
    compiled_sql: 'select * from "vantilburg_dwh"."dbt_prod_seeds"."seed_dim_web_shop"',
    columns: data.seeds[SEED_ID].columns,
    depends_on: [SEED_ID],
    referenced_by: [],
    sources_used: [],
    test_results: [],
    last_run: null,
    catalog_stats: { row_count: null, bytes: null, has_stats: false },
  }

  if (!data.lineage.nodes.some(node => node.id === SEED_ID)) {
    data.lineage.nodes.push({
      id: SEED_ID,
      name: 'seed_dim_web_shop',
      resource_type: 'seed',
      materialization: 'seed',
      schema: 'dbt_prod_seeds',
      database: 'vantilburg_dwh',
      package_name: 'vantilburg_dwh',
      path: 'seeds/seed_dim_web_shop.csv',
      folder: 'seeds',
      tags: [],
      layer: 0,
    })
  }

  return JSON.stringify(data)
}

const fixtureData = buildFixtureData()

test.describe('Seed Data tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureData,
      })
    })
  })

  test('seed page shows Data tab with CSV rows', async ({ page }) => {
    const encodedId = encodeURIComponent(SEED_ID)
    await page.goto(`/#/model/${encodedId}`)
    await page.waitForURL(/#\/model\/seed\./)

    const main = page.locator('main')
    await expect(main.getByRole('heading', { name: 'seed_dim_web_shop' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Data', exact: true })).toBeVisible()

    await main.getByRole('button', { name: 'Data', exact: true }).click()
    await expect(page).toHaveURL(/\/data/)

    const dataTab = page.locator('[data-testid="model-data-tab"]')
    await expect(dataTab).toBeVisible()
    await expect(dataTab.getByText('vantilburg.nl')).toBeVisible()
    await expect(dataTab.getByText('Van Tilburg NL')).toBeVisible()
    await expect(dataTab.getByText('example.com')).toBeVisible()

    await page.screenshot({
      path: path.join(repoRoot, 'assets/verify-seed-data-tab.png'),
    })
  })

  test('seed Data tab deep link opens data view', async ({ page }) => {
    const encodedId = encodeURIComponent(SEED_ID)
    await page.goto(`/#/model/${encodedId}/data`)

    const dataTab = page.locator('[data-testid="model-data-tab"]')
    await expect(dataTab).toBeVisible()
    await expect(dataTab.getByText('VT01')).toBeVisible()
  })

  test('seed Data tab row search filters rows', async ({ page }) => {
    const encodedId = encodeURIComponent(SEED_ID)
    await page.goto(`/#/model/${encodedId}/data`)

    const dataTab = page.locator('[data-testid="model-data-tab"]')
    await page.locator('[data-testid="data-tab-row-search"]').fill('example')
    await expect(dataTab.getByText('example.com')).toBeVisible()
    await expect(dataTab.getByText('vantilburg.nl')).not.toBeVisible()
    await expect(dataTab.getByText('Showing 1 of 2 rows')).toBeVisible()
  })
})
