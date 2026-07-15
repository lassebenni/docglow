import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureData = fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8')

test('tests tab shows compiled SQL for singular and generic tests', async ({ page }) => {
  await page.route('**/docglow-data.json', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: fixtureData,
    })
  })

  await page.goto('/#/model/model.jaffle_shop.orders/tests')
  await page.waitForSelector('[data-testid="model-tests-tab"]')

  const testRow = page.locator('[data-testid="test-row-not_null_orders_order_id"]')
  await expect(testRow).toBeVisible()
  await testRow.click()

  const sqlPanel = page.locator('[data-testid="test-sql-panel"]')
  await expect(sqlPanel).toBeVisible()
  await expect(sqlPanel.getByText('Test SQL (compiled)')).toBeVisible()
  await expect(sqlPanel.locator('pre code')).toContainText('where order_id is null')

  await page.screenshot({
    path: 'test-results/tests-tab-sql-panel.png',
    fullPage: true,
  })
})
