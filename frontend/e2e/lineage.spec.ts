import { test, expect } from '@playwright/test'

const ORDERS_MODEL = 'model.jaffle_shop.orders'

test.describe('Lineage Page', () => {
  test('renders lineage explorer landing', async ({ page }) => {
    await page.goto('/#/lineage')
    await expect(page.getByRole('heading', { name: 'Lineage Explorer' })).toBeVisible()
    await expect(page.getByPlaceholder('Search for a model...')).toBeVisible()
  })

  test.describe('pinned lineage graph', () => {
    test.beforeEach(async ({ page }) => {
      const pins = encodeURIComponent(ORDERS_MODEL)
      await page.goto(`/#/lineage?pins=${pins}&depth=2&dir=both`)
    })

    test('displays filter dropdowns', async ({ page }) => {
      const main = page.locator('main')
      await expect(main.getByRole('button', { name: 'Types' })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Tags' })).toBeVisible()
    })

    test('displays zoom controls', async ({ page }) => {
      const main = page.locator('main')
      await expect(main.locator('.react-flow__controls-zoomin')).toBeVisible()
      await expect(main.locator('.react-flow__controls-fitview')).toBeVisible()
    })
  })
})
