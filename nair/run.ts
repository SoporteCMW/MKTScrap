/**
 * NAIR Competitive Intelligence Scraper
 * Retailers: Amazon US + Walmart
 * Category:  Chemical Depilatories only
 *
 * Usage (from llm-scraper/):
 *   npx tsx nair/run.ts                                          — full run (Amazon + Walmart)
 *   npx tsx nair/run.ts --test                                   — Amazon only, 1 query, 3 products
 *   npx tsx nair/run.ts --brands "Nair,Veet"                    — N brands, 5 products each, Amazon
 *   npx tsx nair/run.ts --brands "Nair,Veet" --retailer walmart — same but Walmart
 *   npx tsx nair/run.ts --brands "Nair,Veet" --per-brand 10     — 10 products per brand
 *
 * Reads ANTHROPIC_API_KEY from ../.env automatically.
 */

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { anthropic } from '@ai-sdk/anthropic'
import { createBrowser, searchRetailer, scrapeProductPage } from './scraper.js'
import { saveJson, saveCsv, ensureDir, randomDelay, log, timestamp } from './utils.js'
import { SEARCH_QUERIES, CATEGORY_QUERIES, BRANDS, RETAILERS, OUTPUT_DIR, DELAY_MIN_MS, DELAY_MAX_MS, MAX_PRODUCTS_PER_BRAND_QUERY, MAX_PRODUCTS_PER_BRAND } from './config.js'
import type { ScrapedProduct } from './schemas.js'
import type { Retailer } from './config.js'

// Load API key from the .env in the project root (parent of llm-scraper/)
function loadApiKey(): void {
  const envPath = resolve('..', '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    const match = content.match(/Anthropic-API-KEY\s*=\s*(.+)/)
    if (match) {
      process.env.ANTHROPIC_API_KEY = match[1].trim()
    } else {
      throw new Error('Anthropic-API-KEY not found in .env')
    }
  } catch (err) {
    console.error(`ERROR loading .env: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

async function main() {
  loadApiKey()

  // ── Mode resolution ──────────────────────────────────────────────────────────
  const args = process.argv.slice(2)
  const isTest        = args.includes('--test')
  const brandIdx      = args.indexOf('--brand')
  const brandsIdx     = args.indexOf('--brands')
  const perBrandIdx   = args.indexOf('--per-brand')
  const retailerIdx   = args.indexOf('--retailer')
  const productIdx    = args.indexOf('--product')
  const perBrand      = perBrandIdx  !== -1 ? parseInt(args[perBrandIdx + 1] ?? '5', 10) : 5
  const retailerArg   = retailerIdx  !== -1 ? (args[retailerIdx + 1] as Retailer) : 'amazon'
  const productSuffix = productIdx   !== -1 ? (args[productIdx + 1] ?? 'hair removal') : 'hair removal'

  type RunMode =
    | { kind: 'full' }
    | { kind: 'test' }
    | { kind: 'brands'; list: string[]; perBrand: number }

  let mode: RunMode
  let retailersToRun: Retailer[]

  if (brandsIdx !== -1) {
    const raw = args[brandsIdx + 1] ?? ''
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    mode = { kind: 'brands', list, perBrand }
    retailersToRun = [retailerArg]
  } else if (brandIdx !== -1) {
    const brand = args[brandIdx + 1] ?? ''
    mode = { kind: 'brands', list: [brand], perBrand }
    retailersToRun = [retailerArg]
  } else if (isTest) {
    mode = { kind: 'test' }
    retailersToRun = ['walmart']
  } else {
    mode = { kind: 'full' }
    retailersToRun = ['walmart']
  }

  const modeLabel =
    mode.kind === 'brands'
      ? `BRANDS (${mode.list.join(', ')} | ${mode.perBrand} products each | ${retailersToRun[0]})`
      : mode.kind === 'test'
      ? 'TEST (1 query, 3 products, Amazon only)'
      : 'FULL'

  log('NAIR Competitive Intelligence Scraper starting')
  log(`Mode:      ${modeLabel}`)
  log(`Retailers: ${retailersToRun.join(', ')}`)
  log('Category:  Chemical Depilatories')
  console.log()

  ensureDir(OUTPUT_DIR)

  const model = anthropic('claude-haiku-4-5-20251001')
  const { browser, context } = await createBrowser()

  const allProducts: ScrapedProduct[] = []
  const seenUrls = new Set<string>()

  // Returns true if the brand name (or its first meaningful token) appears in the URL.
  // Walmart product URLs include the product title slug, e.g. /ip/Veet-Leg-Body-Cream/123
  function brandInUrl(brand: string, url: string): boolean {
    const urlLow = url.toLowerCase()
    const slug = brand.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (urlLow.includes(slug)) return true
    const firstToken = slug.split('-')[0]
    return firstToken.length >= 4 && urlLow.includes(firstToken)
  }

  // Helper: scrape a list of URLs and push results into allProducts
  async function scrapeUrls(urls: string[], retailer: Retailer, label: string, expectedBrand?: string) {
    for (let i = 0; i < urls.length; i++) {
      log(`[${i + 1}/${urls.length}] ${label}`)
      const product = await scrapeProductPage(context, model, urls[i], retailer, expectedBrand)
      if (product) {
        allProducts.push(product)
        log(`  OK: ${product.brand} — ${product.productName} | chemical=${product.isChemicalDepilatory}`)
        saveJson(allProducts, join(OUTPUT_DIR, 'partial_results.json'))
      }
      await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS)
    }
  }

  try {
    if (mode.kind === 'brands') {
      // Per-brand: search + scrape independently so the limit applies per brand
      log(`\n=== AMAZON ===`)
      for (const brand of mode.list) {
        const query =
          SEARCH_QUERIES.find((q) => q.toLowerCase().includes(brand.toLowerCase())) ??
          `${brand} ${productSuffix}`
        log(`\n-- Brand: ${brand} (query: "${query}") --`)

        const retailer = retailersToRun[0]
        const urls = await searchRetailer(context, RETAILERS[retailer](query), retailer)
        const limited = urls.slice(0, mode.perBrand)
        log(`  URLs collected: ${urls.length} → scraping ${limited.length}`)
        await scrapeUrls(limited, retailer, `${retailer.toUpperCase()} / ${brand}`, brand)
        await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS)
      }
    } else if (mode.kind === 'test') {
      // Test: 1 brand, 1 category query, 3 products
      const retailer = retailersToRun[0]
      const query = `${BRANDS[0]} ${CATEGORY_QUERIES[0]}`
      log(`\nQuery: "${query}"`)
      const urls = await searchRetailer(context, RETAILERS[retailer](query), retailer)
      await scrapeUrls(urls.slice(0, 3), retailer, retailer.toUpperCase(), BRANDS[0])

    } else {
      // Full: brand × category matrix
      // For each brand: search "{brand} {categoryQuery}" for every category,
      // collect up to MAX_PRODUCTS_PER_BRAND_QUERY new URLs per search,
      // cap at MAX_PRODUCTS_PER_BRAND per brand, then scrape.
      for (const retailer of retailersToRun) {
        log(`\n=== ${retailer.toUpperCase()} ===`)

        for (const brand of BRANDS) {
          log(`\n-- Brand: ${brand} --`)
          const brandUrls: string[] = []
          const brandSeen = new Set<string>()

          for (const categoryQuery of CATEGORY_QUERIES) {
            if (brandUrls.length >= MAX_PRODUCTS_PER_BRAND) break
            const combined = `${brand} ${categoryQuery}`
            log(`  Query: "${combined}"`)
            const urls = await searchRetailer(context, RETAILERS[retailer](combined), retailer)
            let added = 0
            for (const url of urls) {
              if (brandUrls.length >= MAX_PRODUCTS_PER_BRAND) break
              if (!brandInUrl(brand, url)) continue
              if (!seenUrls.has(url) && !brandSeen.has(url) && added < MAX_PRODUCTS_PER_BRAND_QUERY) {
                seenUrls.add(url)
                brandSeen.add(url)
                brandUrls.push(url)
                added++
              }
            }
            log(`  +${added} URLs → brand total: ${brandUrls.length}`)
            await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS)
          }

          log(`  Scraping ${brandUrls.length} products for ${brand}`)
          await scrapeUrls(brandUrls, retailer, `${retailer.toUpperCase()} / ${brand}`, brand)
        }
      }
    }
  } finally {
    await browser.close()
  }

  // ── Final export ────────────────────────────────────────────────────────────
  const chemicalOnly = allProducts.filter((p) => p.isChemicalDepilatory)
  const ts = timestamp()

  saveJson(allProducts, join(OUTPUT_DIR, `all_products_${ts}.json`))
  saveJson(chemicalOnly, join(OUTPUT_DIR, `chemical_depilatories_${ts}.json`))
  saveCsv(chemicalOnly, join(OUTPUT_DIR, `competitive_portfolio_${ts}.csv`))

  console.log()
  log('DONE')
  log(`Total products scraped:    ${allProducts.length}`)
  log(`Chemical depilatories:     ${chemicalOnly.length}`)
  log(`Output directory:          ${OUTPUT_DIR}/`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
