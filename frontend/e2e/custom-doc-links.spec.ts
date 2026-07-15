import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const baseFixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8'),
) as Record<string, unknown>

const modelId = 'model.demo.custom_doc_links'
const modelUrl = `/#/model/${modelId}/guide`

function buildCustomDocData() {
  const data = structuredClone(baseFixture) as {
    metadata: { project_name: string }
    models: Record<string, Record<string, unknown>>
    lineage: { nodes: Array<Record<string, unknown>> }
  }

  data.metadata.project_name = 'demo'
  data.models[modelId] = {
    unique_id: modelId,
    name: 'custom_doc_links',
    description: 'Fixture for guide/workbook cross-linking',
    schema: 'demo',
    database: 'demo',
    materialization: 'view',
    tags: [],
    meta: {},
    path: 'models/custom_doc_links.sql',
    folder: 'models',
    raw_sql: 'select 1',
    compiled_sql: 'select 1',
    columns: [],
    depends_on: [],
    referenced_by: [],
    sources_used: [],
    test_results: [],
    last_run: null,
    custom_docs: [
      { slug: 'guide', label: 'Guide', url: 'docs/demo_model/guide.html' },
      { slug: 'workbook', label: 'Workbook', url: 'docs/demo_model/workbook.html' },
    ],
    questions: [
      {
        question: 'Hoe actueel is stock_current?',
        answer: 'Via snapshot freshness check.',
        proof: 'workbook#cte-snapshot_freshness_check',
      },
    ],
  }

  data.lineage.nodes.push({
    id: modelId,
    name: 'custom_doc_links',
    resource_type: 'model',
    materialization: 'view',
    schema: 'demo',
    test_status: 'none',
    has_description: true,
    folder: 'models',
    tags: [],
    layer: 3,
    layer_auto: false,
  })

  return data
}

function workbookFrame(page: import('@playwright/test').Page) {
  return page.frameLocator('[data-testid="custom-doc-workbook"] iframe')
}

function guideFrame(page: import('@playwright/test').Page) {
  return page.frameLocator('[data-testid="custom-doc-guide"] iframe')
}

test.describe('Custom doc guide/workbook linking', () => {
  test.beforeEach(async ({ page }) => {
    const payload = buildCustomDocData()
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      })
    })
    await page.goto(modelUrl)
    await page.waitForSelector('h1:has-text("custom_doc_links")')
    await guideFrame(page).locator('h1').waitFor()
  })

  test('guide iframe loads content', async ({ page }) => {
    await expect(guideFrame(page).getByRole('heading', { name: /demo guide/i })).toBeVisible()
  })

  test('workbook#anchor link from guide switches tab and scrolls', async ({ page }) => {
    await guideFrame(page).getByRole('link', { name: 'snapshot freshness' }).click()
    await expect(page).toHaveURL(/\/workbook/)
    await expect(workbookFrame(page).getByRole('heading', { name: 'Snapshot freshness check' })).toBeInViewport()
  })

  test('guide#anchor link from workbook switches tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Workbook', exact: true }).click()
    await workbookFrame(page).locator('h1').waitFor()
    await workbookFrame(page).getByRole('link', { name: 'Terug naar inhoudsopgave' }).click()
    await expect(page).toHaveURL(/\/guide/)
    await expect(guideFrame(page).getByRole('heading', { name: /demo guide/i })).toBeVisible()
  })

  test('same-page anchor in workbook scrolls without leaving tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Workbook', exact: true }).click()
    const frame = workbookFrame(page)
    await frame.locator('h1').waitFor()
    await frame.getByRole('link', { name: '#cte-sales_measures_check' }).click()
    await expect(page).toHaveURL(/\/workbook/)
    await expect(frame.getByRole('heading', { name: 'Sales measures check' })).toBeInViewport()
  })

  test('questions proof link opens workbook at anchor', async ({ page }) => {
    await page.getByRole('button', { name: /Questions/ }).click()
    await page.getByTestId('question-proof-link').click()
    await expect(page).toHaveURL(/\/workbook/)
    await expect(workbookFrame(page).getByRole('heading', { name: 'Snapshot freshness check' })).toBeInViewport()
  })
})
