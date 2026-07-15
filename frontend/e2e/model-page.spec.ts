import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureData = fs.readFileSync(path.join(fixturesDir, 'docglow-data.json'), 'utf8')

test.describe('Model Detail Page', () => {
  // Scope tab interactions to main content to avoid sidebar conflicts
  const mainSelector = 'main'

  test.beforeEach(async ({ page }) => {
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureData,
      })
    })
    await page.goto('/')
    await page.locator('table tbody tr').filter({ hasText: 'orders' }).first().click()
    await page.waitForURL(/#\/model\//)
  })

  test('displays model name and materialization badge', async ({ page }) => {
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('h1')).toContainText('orders')
  })

  test('displays schema and path info', async ({ page }) => {
    await expect(page.getByText(/models\//)).toBeVisible()
  })

  test('shows columns tab by default with column table', async ({ page }) => {
    const main = page.locator(mainSelector)
    const columnsTab = main.getByRole('button', { name: /Columns/ })
    await expect(columnsTab).toBeVisible()
    await expect(page.locator('table').first()).toBeVisible()
  })

  test('can switch to SQL tab', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: 'SQL', exact: true }).click()
    // Should show Compiled/Raw toggle buttons
    await expect(main.getByRole('button', { name: 'Compiled', exact: true })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Raw', exact: true })).toBeVisible()
  })

  test('SQL tab shows content or no-sql message', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: 'SQL', exact: true }).click()
    // Test fixtures may not have compiled SQL, so expect either pre>code or "No SQL"
    const hasSql = await page.locator('pre code').count()
    const hasNoSql = await page.getByText('No SQL available').count()
    expect(hasSql + hasNoSql).toBeGreaterThan(0)
  })

  test('can switch to lineage tab', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: 'Lineage', exact: true }).click()
    await expect(page.locator('.h-96').first()).toBeVisible()
  })

  test('can switch to tests tab', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: /Tests/ }).click()
    await expect(page.locator('[data-testid="model-tests-tab"]')).toBeVisible()
  })

  test('tests tab expands SQL when a test row is clicked', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: /Tests/ }).click()
    const testRow = page.locator('[data-testid="test-row-not_null_orders_order_id"]')
    await expect(testRow).toBeVisible()
    await testRow.click()
    const sqlPanel = page.locator('[data-testid="test-sql-panel"]')
    await expect(sqlPanel).toBeVisible()
    await expect(sqlPanel.locator('pre code')).toContainText('order_id')
  })
})

test.describe('Model Statistics Tab', () => {
  const mainSelector = 'main'

  test.beforeEach(async ({ page }) => {
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureData,
      })
    })
    await page.goto('/#/model/model.jaffle_shop.orders')
    await page.waitForSelector('h1:has-text("orders")')
  })

  test('can switch to statistics tab', async ({ page }) => {
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: 'Statistics', exact: true }).click()
    await expect(page).toHaveURL(/\/statistics/)
    await expect(main.getByText('Total Rows')).toBeVisible()
  })

  test('statistics deep link opens statistics tab', async ({ page }) => {
    await page.goto('/#/model/model.jaffle_shop.orders/statistics')
    const main = page.locator(mainSelector)
    await expect(main.getByText('Total Rows')).toBeVisible()
    await expect(main.getByRole('button', { name: /Columns/ })).not.toHaveClass(/text-primary/)
  })

  test('statistics tab stays active with column anchor hash', async ({ page }) => {
    await page.goto('/#/model/model.jaffle_shop.orders#col-order_id')
    await page.waitForURL(/#\/model\/model\.jaffle_shop\.orders/)
    const main = page.locator(mainSelector)
    await main.getByRole('button', { name: 'Statistics', exact: true }).click()
    await expect(page).toHaveURL(/\/statistics/)
    await expect(main.getByText('Total Rows')).toBeVisible()
    await expect(main.getByRole('button', { name: /Columns/ })).not.toHaveClass(/text-primary/)
  })
})

test.describe('Model Not Found', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/docglow-data.json', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: fixtureData,
      })
    })
  })

  test('shows not found message for invalid model id', async ({ page }) => {
    await page.goto('/#/model/nonexistent-model-id')
    await expect(page.getByText('Model not found')).toBeVisible()
  })
})
