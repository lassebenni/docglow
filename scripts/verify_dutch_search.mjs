#!/usr/bin/env node
/**
 * Verify Dutch business term search (omzet, waardebon, retouren) in Cmd+K.
 *
 * Lexical check (default):
 *   node scripts/verify_dutch_search.mjs --site /tmp/vt-docglow-dutch
 *
 * Optional browser screenshots (requires running docglow serve + Playwright):
 *   node scripts/verify_dutch_search.mjs --site /tmp/vt-docglow-dutch --browser --base http://127.0.0.1:8086
 */
import { createRequire } from 'module'
import { existsSync, readFileSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function parseArgs(argv) {
  const opts = {
    site: '/tmp/vt-docglow-dutch',
    data: null,
    browser: false,
    base: 'http://127.0.0.1:8086',
    assets: resolve(ROOT, 'assets'),
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--browser') {
      opts.browser = true
    } else if (arg === '--site') {
      opts.site = argv[++i]
    } else if (arg === '--data') {
      opts.data = argv[++i]
    } else if (arg === '--base') {
      opts.base = argv[++i]
    } else if (arg === '--assets') {
      opts.assets = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      console.log(`usage: node scripts/verify_dutch_search.mjs [options]

  --site PATH     Output dir with index.html or docglow-data.json (default: /tmp/vt-docglow-dutch)
  --data PATH     Explicit docglow-data.json path (overrides --site)
  --browser       Capture Cmd+K screenshots (needs Playwright + running server)
  --base URL      Site URL for --browser (default: http://127.0.0.1:8086)
  --assets PATH   Screenshot output dir (default: assets/)
`)
      process.exit(0)
    }
  }
  return opts
}

function loadDocglowData({ site, data }) {
  if (data) {
    return JSON.parse(readFileSync(data, 'utf8'))
  }
  const jsonPath = join(site, 'docglow-data.json')
  if (existsSync(jsonPath)) {
    return JSON.parse(readFileSync(jsonPath, 'utf8'))
  }
  const htmlPath = join(site, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(`No docglow data at ${jsonPath} or ${htmlPath}`)
  }
  const html = readFileSync(htmlPath, 'utf8')
  const marker = 'window.__DOCGLOW_DATA__='
  const start = html.indexOf(marker)
  if (start < 0) {
    throw new Error(`Could not find embedded docglow data in ${htmlPath}`)
  }
  const jsonStart = start + marker.length
  const jsonEnd = html.indexOf(';</script>', jsonStart)
  if (jsonEnd < 0) {
    throw new Error(`Malformed embedded docglow data in ${htmlPath}`)
  }
  return JSON.parse(html.slice(jsonStart, jsonEnd))
}

const opts = parseArgs(process.argv)
const require = createRequire(resolve(ROOT, 'frontend/node_modules/minisearch/package.json'))
const MiniSearch = require('minisearch').default ?? require('minisearch')

const data = loadDocglowData(opts)
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

let failed = false
for (const [query, expectedNames] of Object.entries(expectations)) {
  const hits = resourceIndex.search(query).slice(0, 10)
  const hitNames = hits.map(h => h.name)
  const ok = expectedNames.some(n => hitNames.includes(n))
  console.log(`query "${query}":`, hitNames.slice(0, 5).join(', '), ok ? 'OK' : 'MISSING expected')
  if (!ok) failed = true
}

if (failed) {
  process.exit(1)
}

if (!opts.browser) {
  console.log('\nLexical checks passed. Pass --browser to capture screenshots.')
  process.exit(0)
}

const { chromium } = require('playwright')

async function browserDemo() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(`${opts.base}/`)
  await page.waitForSelector('text=Search...', { timeout: 30000 })

  for (const query of ['omzet', 'waardebon', 'retouren']) {
    await page.getByText('Search...').click()
    const input = page.getByPlaceholder('Search models, columns, sources...')
    await input.fill('')
    await input.fill(query)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${opts.assets}/verify-dutch-search-${query}.png` })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }

  await browser.close()
  console.log(`\nScreenshots: ${opts.assets}/verify-dutch-search-{omzet,waardebon,retouren}.png`)
}

await browserDemo()
