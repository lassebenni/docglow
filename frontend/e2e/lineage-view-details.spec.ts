import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureData = fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8')

const MODEL_ID = 'model.jaffle_shop.orders'
const UPSTREAM_ID = 'model.jaffle_shop.stg_orders'

test.describe('Lineage View details', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureData,
      })
    })
  })

  test('View details opens upstream model in a new tab', async ({ page, context }) => {
    const encodedId = encodeURIComponent(MODEL_ID)
    await page.goto(`/#/model/${encodedId}/lineage`)
    await page.waitForURL(/#\/model\/.*\/lineage/)

    const main = page.locator('main')
    await expect(main.getByRole('heading', { name: 'orders' })).toBeVisible()

    // Single-click an upstream node to open the side panel (250ms debounce before panel opens).
    await main.locator('.react-flow__node').filter({ hasText: 'stg_orders' }).first().click()
    const viewDetails = page.getByTestId('lineage-view-details-link')
    await expect(viewDetails).toBeVisible()
    await expect(viewDetails).toHaveAttribute('target', '_blank')

    const originalUrl = page.url()
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      viewDetails.click(),
    ])

    await expect(newPage).toHaveURL(
      new RegExp(`#/model/${encodeURIComponent(UPSTREAM_ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    await expect(page).toHaveURL(originalUrl)

    if (process.env.VERIFY_SCREENSHOT === '1') {
      const repoRoot = path.join(fixturesDir, '../../..')
      await page.screenshot({
        path: path.join(repoRoot, 'assets/verify-lineage-view-details-panel.png'),
      })
    }
  })

  test('View details on global lineage opens model in a new tab', async ({ page, context }) => {
    const pins = encodeURIComponent(MODEL_ID)
    await page.goto(`/#/lineage?pins=${pins}&depth=2&dir=both`)
    await page.waitForURL(/#\/lineage/)

    const main = page.locator('main')
    const stgOrdersNode = main.locator('.react-flow__node').filter({ hasText: 'stg_orders' }).first()
    await expect(stgOrdersNode).toBeVisible()

    await stgOrdersNode.click()
    const viewDetails = page.getByTestId('lineage-view-details-link')
    await expect(viewDetails).toBeVisible()
    await expect(viewDetails).toHaveAttribute('target', '_blank')

    const originalUrl = page.url()
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      viewDetails.click(),
    ])

    await expect(newPage).toHaveURL(
      new RegExp(`#/model/${encodeURIComponent(UPSTREAM_ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    await expect(page).toHaveURL(originalUrl)
  })
})
