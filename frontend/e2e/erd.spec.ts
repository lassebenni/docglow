import { test, expect } from '@playwright/test'

const ORDERS_MODEL = 'model.jaffle_shop.orders'

test.describe('ERD Page', () => {
  test('landing shows ERD Explorer and relationship summary', async ({ page }) => {
    await page.goto('/#/erd')
    await expect(page.getByRole('heading', { name: 'ERD Explorer' })).toBeVisible()
    await expect(page.getByText(/\d+ models · \d+ relationships/)).toBeVisible()
  })

  test('renders ERD nav in sidebar', async ({ page }) => {
    await page.goto('/#/erd')
    await expect(page.locator('aside').getByRole('button', { name: /^ERD$/ })).toBeVisible()
  })

  test.describe('focused ERD canvas', () => {
    test.beforeEach(async ({ page }) => {
      const focus = encodeURIComponent(ORDERS_MODEL)
      await page.goto(`/#/erd?focus=${focus}&depth=2`)
    })

    test('renders segmented node-state controls', async ({ page }) => {
      const main = page.locator('main')
      await expect(main.getByRole('button', { name: 'Compact' })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Keys' })).toBeVisible()
      await expect(main.getByRole('button', { name: 'Full' })).toBeVisible()
    })

    test('renders relationship count in focus bar', async ({ page }) => {
      const main = page.locator('main')
      await expect(main.getByText(/\d+ tables · \d+ relationships/).first()).toBeVisible()
    })

    test('renders model nodes', async ({ page }) => {
      await expect(page.getByText('orders', { exact: true }).first()).toBeVisible()
    })

    test('top-bar state toggle changes active button', async ({ page }) => {
      const main = page.locator('main')
      const compactBtn = main.getByRole('button', { name: 'Compact' })
      const fullBtn = main.getByRole('button', { name: 'Full' })

      await compactBtn.click()
      await expect(compactBtn).toHaveAttribute('aria-pressed', 'true')
      await expect(fullBtn).toHaveAttribute('aria-pressed', 'false')

      await fullBtn.click()
      await expect(fullBtn).toHaveAttribute('aria-pressed', 'true')
      await expect(compactBtn).toHaveAttribute('aria-pressed', 'false')
    })
  })
})
