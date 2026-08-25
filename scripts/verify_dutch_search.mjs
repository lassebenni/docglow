#!/usr/bin/env node
/**
 * Verify Dutch business term search (omzet, waardebon, retouren) in Cmd+K.
 * Run from frontend/: node ../scripts/verify_dutch_search.mjs
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ASSETS = resolve(ROOT, 'assets')
const SITE = '/tmp/vt-docglow-dutch'
const BASE = 'http://127.0.0.1:8086'

const require = createRequire(resolve(ROOT, 'frontend/node_modules/minisearch/package.json'))
const MiniSearch = require('minisearch').default ?? require('minisearch')
const { chromium } = require('playwright')

const data = JSON.parse(readFileSync(`${SITE}/docglow-data.json`, 'utf8'))
const resources = data.search_index.filter(e => e.resource_type !== 'column')

const resourceIndex = new MiniSearch({
  fields: ['name', 'description', 'tags', 'aliases'],
  storeFields: ['id', 'unique_id', 'name', 'resource_type', 'description', 'tags', 'aliases'],
  idField: 'id',
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { name: 2, aliases: 2 } },
})
resourceIndex.addAll(resources)

const expectations = {
  omzet: ['turnover_entry', 'stg_xprt__turnover_entry'],
  waardebon: ['stg_xprt__pos_trans_line', 'turnover_entry'],
  retouren: ['stg_xprt__sales_cr_memo_line', 'stg_xprt__pos_trans_line'],
}

for (const [query, expectedNames] of Object.entries(expectations)) {
  const hits = resourceIndex.search(query).slice(0, 10)
  const hitNames = hits.map(h => h.name)
  const ok = expectedNames.some(n => hitNames.includes(n))
  console.log(`query "${query}":`, hitNames.slice(0, 5).join(', '), ok ? 'OK' : 'MISSING expected')
  if (!ok) process.exitCode = 1
}

async function browserDemo() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${BASE}/`)
  await page.waitForSelector('text=Search...', { timeout: 30000 })

  for (const query of ['omzet', 'waardebon', 'retouren']) {
    await page.getByText('Search...').click()
    const input = page.getByPlaceholder('Search models, columns, sources...')
    await input.fill('')
    await input.fill(query)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${ASSETS}/verify-dutch-search-${query}.png` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }

  await browser.close()
  console.log('\nScreenshots: assets/verify-dutch-search-{omzet,waardebon,retouren}.png')
}

await browserDemo()
