import { test, expect } from '@playwright/test'

test.describe('ERD Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/erd')
  })

  test('renders ERD nav and segmented controls', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^ERD$/ })).toBeVisible()
    const main = page.locator('main')
    // Segmented control exposes three node-state buttons.
    await expect(main.getByRole('button', { name: 'Compact' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Keys' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Full' })).toBeVisible()
  })

  test('renders relationship count badge', async ({ page }) => {
    await expect(page.getByText(/\d+ relationships/)).toBeVisible()
  })

  test('renders model nodes', async ({ page }) => {
    // jaffle-shop has an `orders` model with multiple relationships, so it
    // should be visible in the canvas regardless of node-state default.
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
