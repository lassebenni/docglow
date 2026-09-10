import { test, expect, type Locator } from '@playwright/test'

/** Tag filter chips live in the sidebar Tags row — not folder names like "staging". */
function tagChips(sidebar: Locator) {
  return sidebar.locator('div.flex.flex-wrap.gap-1')
}

test.describe('Tag Filtering', () => {
  test.describe('from home', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
    })

  test('sidebar displays tag chips when tags exist', async ({ page }) => {
    const sidebar = page.locator('aside')
    await expect(sidebar.getByText('Tags')).toBeVisible()
    // Should show tags from the fixture data
    const chips = tagChips(sidebar)
    await expect(chips.getByRole('button', { name: 'finance' })).toBeVisible()
    await expect(chips.getByRole('button', { name: 'staging' })).toBeVisible()
    await expect(chips.getByRole('button', { name: 'marketing' })).toBeVisible()
    await expect(chips.getByRole('button', { name: 'daily' })).toBeVisible()
  })

  test('clicking a tag chip filters the sidebar model list', async ({ page }) => {
    const sidebar = page.locator('aside')

    // Expand models folder to see all models
    await sidebar.getByRole('button', { name: /^models/ }).click()

    // Count initial models visible (before filter)
    const modelsSection = sidebar.locator('nav')
    const initialButtons = await modelsSection.getByRole('button').allTextContents()
    const initialModelNames = initialButtons.filter(t =>
      !['models', 'sources', 'Expand All', 'Collapse All', 'Lineage', 'Health', 'Layers',
        'finance', 'staging', 'marketing', 'daily', 'Clear'].includes(t.trim()) &&
      !t.match(/^\d+$/) &&
      !t.includes('/')
    )

    // Click 'finance' tag
    await tagChips(sidebar).getByRole('button', { name: 'finance' }).click()

    // Footer should show filtered count
    await expect(sidebar.getByText(/\d+ of \d+ models/)).toBeVisible()

    // The 'finance' chip should be highlighted (has bg-primary style)
    const financeChip = tagChips(sidebar).getByRole('button', { name: 'finance' })
    await expect(financeChip).toHaveClass(/bg-primary/)
  })

  test('clicking Clear removes the tag filter', async ({ page }) => {
    const sidebar = page.locator('aside')

    // Activate a tag filter
    await tagChips(sidebar).getByRole('button', { name: 'finance' }).click()
    await expect(sidebar.getByText(/\d+ of \d+ models/)).toBeVisible()

    // Clear the filter
    await sidebar.getByRole('button', { name: 'Clear' }).click()

    // Footer should show unfiltered count (no "of")
    await expect(sidebar.getByText(/\d+ models · \d+ sources/)).toBeVisible()
    await expect(sidebar.getByText(/\d+ of \d+ models/)).not.toBeVisible()
  })

  test('tag filter persists in URL params', async ({ page }) => {
    const sidebar = page.locator('aside')

    // Click 'staging' tag
    await tagChips(sidebar).getByRole('button', { name: 'staging' }).click()

    // URL should contain tags param
    await expect(page).toHaveURL(/tags=staging/)
  })

  test('overview page shows filtered models heading when tags active', async ({ page }) => {
    const sidebar = page.locator('aside')

    // No filter — shows "Recent Models"
    await expect(page.getByText('Recent Models')).toBeVisible()

    // Click a tag filter
    await tagChips(sidebar).getByRole('button', { name: 'finance' }).click()

    // Should now show "Filtered Models"
    await expect(page.getByText('Filtered Models')).toBeVisible()
  })

  test('multiple tags can be selected', async ({ page }) => {
    const sidebar = page.locator('aside')

    await tagChips(sidebar).getByRole('button', { name: 'finance' }).click()
    await tagChips(sidebar).getByRole('button', { name: 'staging' }).click()

    // Both chips should be active
    await expect(tagChips(sidebar).getByRole('button', { name: 'finance' })).toHaveClass(/bg-primary/)
    await expect(tagChips(sidebar).getByRole('button', { name: 'staging' })).toHaveClass(/bg-primary/)

    // URL should contain both tags
    await expect(page).toHaveURL(/tags=/)
  })
  })

  test('tag filter restores from URL params on load', async ({ page }) => {
    // First navigation must include tags — the store reads the hash only at init.
    await page.goto('/#/?tags=finance')

    const sidebar = page.locator('aside')
    const financeChip = tagChips(sidebar).getByRole('button', { name: 'finance' })
    await expect(financeChip).toHaveClass(/bg-primary/)
    await expect(sidebar.getByText(/\d+ of \d+ models/)).toBeVisible()
  })
})
