import { chromium, type BrowserContext, type Page } from 'playwright'
import { generateText, Output } from 'ai'
import type { LanguageModel } from 'ai'
import { ProductDetailSchema, type ScrapedProduct } from './schemas.js'
import { randomDelay, log } from './utils.js'
import { MAX_PRODUCTS_PER_QUERY, DELAY_MIN_MS, DELAY_MAX_MS } from './config.js'
import type { Retailer } from './config.js'

// ── System prompt for product detail extraction ──────────────────────────────

const DETAIL_SYSTEM_PROMPT = `You are a competitive intelligence analyst for Nair (Church & Dwight), specializing in the chemical depilatory category.

Extract structured product data from this retail product page.

CLASSIFICATION RULES:
- isChemicalDepilatory=true ONLY if the product uses a thioglycolate-based or equivalent chemical active to dissolve hair (creams, masks, gels, lotions)
- isChemicalDepilatory=false for: wax strips, hot wax, sugar wax, razors, shaving cream (without chemical depilatory), epilators, IPL devices, laser devices, hair growth inhibitors
- When uncertain, default to false

EXTRACTION RULES:
- claims: extract every claim visible in the product title, bullet points, and description
- heroIngredients: only ingredients explicitly highlighted in marketing copy, not the full INCI list
- fullInci: copy the complete ingredients section verbatim if present on the page
- innovationAxis: identify the single most distinctive positioning (e.g. "skincare-infused", "low-odor", "rapid-action 3-min", "sensitive skin", "mens grooming", "in-shower", "bikini precision")
- price: use the main selling price, not the per-unit breakdown`

// ── Browser setup ────────────────────────────────────────────────────────────

export async function createBrowser() {
  const browser = await chromium.launch({
    executablePath: 'C:\\chrome-win64\\chrome-win64\\chrome.exe',
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-automation',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--lang=en-US',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  })

  await context.addInitScript(() => {
    // Remove automation flags
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    // Realistic plugins
    Object.defineProperty(navigator, 'plugins', { get: () => ({ length: 5 }) })
    // Realistic languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    // Realistic hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
    // Fix chrome runtime presence (expected by Walmart)
    // @ts-ignore
    if (!window.chrome) (window as any).chrome = { runtime: {} }
    // Permissions — return 'denied' for notifications (bots usually have 'default')
    const origQuery = window.navigator.permissions.query.bind(navigator.permissions)
    window.navigator.permissions.query = (p: any) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus)
        : origQuery(p)
  })

  return { browser, context }
}

// ── Bot-block detection ──────────────────────────────────────────────────────

function looksLikeChallenge(title: string, url: string): boolean {
  const t = title.toLowerCase()
  return (
    t.includes('captcha') ||
    t.includes('robot check') ||
    t.includes('robot or human') ||
    t.includes('press & hold') ||
    t.includes('press and hold') ||
    t.includes('access denied') ||
    t.includes('403') ||
    url.includes('captcha') ||
    url.includes('blocked') ||
    url.includes('sorry/index')
  )
}

// Attempt to auto-solve Walmart's two-step "Press & Hold / Press again" challenge.
// Step 1 – click the accessibility circle (converts hold→click challenge)
// Step 2 – click the main button ("Press & Hold" or "Press again")
// Falls back to 90s manual window if automation fails.
async function handleBotChallenge(page: Page): Promise<boolean> {
  const title = await page.title()
  const url   = page.url()

  // Check title/URL first; if clean, also probe DOM for the accessibility challenge button
  const titleUrlChallenge = looksLikeChallenge(title, url)
  const domChallenge = titleUrlChallenge ? false : await page
    .locator('[aria-label="Accessible challenge"]')
    .isVisible({ timeout: 2000 })
    .catch(() => false)

  if (!titleUrlChallenge && !domChallenge) return false

  log('  Bot challenge detected — attempting auto-solve…')

  const tryClick = async (locator: ReturnType<typeof page.locator>, label: string) => {
    try {
      await locator.waitFor({ timeout: 4000 })
      const box = await locator.boundingBox()
      if (!box) return false
      const cx = box.x + box.width  / 2
      const cy = box.y + box.height / 2
      await page.mouse.move(cx + 60, cy - 30)
      await page.waitForTimeout(150 + Math.random() * 150)
      await page.mouse.move(cx, cy, { steps: 10 })
      await page.waitForTimeout(80  + Math.random() * 100)
      await page.mouse.click(cx, cy)
      log(`  Clicked: ${label}`)
      return true
    } catch { return false }
  }

  // The challenge renders inside an iframe — find which frame hosts it
  await page.waitForTimeout(1500)

  type AnyFrame = import('playwright').Page | import('playwright').Frame
  let challengeFrame: AnyFrame = page
  let accessBtn = page.locator('[aria-label="Accessible challenge"]')

  for (const frame of page.frames()) {
    const loc = frame.locator('[aria-label="Accessible challenge"]')
    const found = await loc.isVisible({ timeout: 1000 }).catch(() => false)
    if (found) {
      challengeFrame = frame
      accessBtn = loc
      log(`  Found challenge in frame: ${frame.url().slice(0, 60)}`)
      break
    }
  }

  // Retry loop — "Please try again" means timing was off; retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`  Attempt ${attempt}/3…`)
    try {
      // ── Step 1: click accessibility button
      const clickedAccess = await tryClick(accessBtn.first(), 'Accessible challenge button')
      if (!clickedAccess) {
        log('  WARNING: accessibility button not found in any frame')
        break
      }

      // ── Step 2: wait for "Press again" to appear, then wait for its CSS animation
      // to finish (4178ms) before clicking — clicking mid-animation causes "Please try again"
      const pressAgain = challengeFrame.locator('p').filter({ hasText: /press\s+again/i }).first()
      log('  Waiting for "Press again"…')
      await pressAgain.waitFor({ state: 'visible', timeout: 12000 })
      log('  Waiting for animation to complete (4.2s)…')
      await page.waitForTimeout(4300) // animation duration is 4178ms
      await tryClick(pressAgain, 'Press again')
      await page.waitForTimeout(1500)

      // ── Check for "Please try again" — means the attempt failed, loop again
      const tryAgain = challengeFrame.locator('p, span, div').filter({ hasText: /please\s+try\s+again/i }).first()
      const failed = await tryAgain.isVisible({ timeout: 2000 }).catch(() => false)
      if (!failed) {
        log('  Challenge appears resolved')
        break
      }
      log(`  "Please try again" detected — retrying (${attempt}/3)`)
      await page.waitForTimeout(1000 * attempt) // back off slightly each retry

    } catch (err) {
      log(`  Attempt ${attempt} error: ${err instanceof Error ? err.message : String(err)}`)
      if (attempt < 3) await page.waitForTimeout(1000)
    }
  }

  // Wait for page to settle, then check result
  await page.waitForTimeout(3000)

  const finalTitle = await page.title()
  const finalUrl   = page.url()
  log(`  Post-solve — title: "${finalTitle.slice(0, 60)}" | url: ${finalUrl.slice(0, 60)}`)

  // Primary check: if the accessibility challenge button is gone from ALL frames → success
  let challengeStillVisible = false
  for (const frame of page.frames()) {
    const visible = await frame.locator('[aria-label="Accessible challenge"]')
      .isVisible({ timeout: 500 }).catch(() => false)
    if (visible) { challengeStillVisible = true; break }
  }

  const stillBlocked = challengeStillVisible || looksLikeChallenge(finalTitle, finalUrl)
  if (!stillBlocked) {
    log('  Auto-solve succeeded!')
    return false
  }
  log(`  Still blocked — challengeVisible=${challengeStillVisible} titleMatch=${looksLikeChallenge(finalTitle, finalUrl)}`)

  // Fallback: wait for manual solve in the headed browser window
  log('  *** Auto-solve failed — solve it manually in the browser window (90s) ***')
  try {
    const snap = { t: await page.title(), u: page.url() }
    await page.waitForFunction(
      ({ t, u }: { t: string; u: string }) =>
        document.title !== t || location.href !== u,
      snap,
      { timeout: 90_000 },
    )
    log('  Challenge resolved manually — continuing')
    await page.waitForTimeout(1500)
  } catch {
    log('  Challenge not solved within 90s — skipping this page')
    return true
  }

  return looksLikeChallenge(await page.title(), page.url())
}

// ── Targeted content extraction: only the product-relevant sections ──────────
// Uses $eval/$$$eval with simple anonymous lambdas to avoid the tsx/esbuild
// __name() serialization bug that breaks page.evaluate() with named functions.

async function extractProductContent(page: Page, retailer: Retailer): Promise<string> {
  // Try each selector in order, return first non-empty result
  const t = async (...sels: string[]): Promise<string> => {
    for (const sel of sels) {
      try {
        const v = await page.$eval(sel, (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        if (v) return v
      } catch { /* not found */ }
    }
    return ''
  }

  const all = async (sel: string): Promise<string[]> => {
    try {
      return await page.$$eval(sel, (els) =>
        (els as HTMLElement[])
          .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter((s) => s.length > 0),
      )
    } catch { return [] }
  }

  if (retailer === 'amazon') {
    const [title, price, bullets, description, details, techSpecs, aplus, rating, reviewCount] =
      await Promise.all([
        t('#productTitle'),
        t('.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', '.a-price'),
        all('#feature-bullets li span:not(.aok-hidden)'),
        t('#productDescription p', '#productDescription'),
        t('#detailBullets_feature_div', '#productDetails_feature_div'),
        t('#productDetails_techSpec_section_1'),
        t('#aplus_feature_div', '#aplus3p_feature_div'),
        t('#acrPopover .a-size-base.a-color-base', 'span[data-hook="rating-out-of-text"]', '.a-icon-alt'),
        t('#acrCustomerReviewText'),
      ])

    return [
      title && `TITLE: ${title}`,
      price && `PRICE: ${price}`,
      bullets.length && `FEATURES:\n${bullets.map((b) => `- ${b}`).join('\n')}`,
      description && `DESCRIPTION:\n${description}`,
      details && `PRODUCT DETAILS:\n${details}`,
      techSpecs && `TECH SPECS:\n${techSpecs}`,
      aplus && `ADDITIONAL INFO:\n${aplus.slice(0, 2000)}`,
      rating && `RATING: ${rating}`,
      reviewCount && `REVIEWS: ${reviewCount}`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  // Walmart: walk UP the DOM from the matching heading until we reach an ancestor
  // that contains a <p> with substantial content — covers any nesting depth.
  const sectionByHeading = async (keyword: string): Promise<string> => {
    try {
      return await page.$$eval(
        'h2, h3, h4',
        (headings, kw) => {
          const heading = (headings as HTMLElement[]).find((el) =>
            el.textContent?.toLowerCase().includes((kw as string).toLowerCase()),
          )
          if (!heading) return ''

          // Walk UP the tree until we find an ancestor that also contains
          // a <p> (or <span>/<div>) with >30 chars that isn't the heading itself
          let container: HTMLElement | null = heading.parentElement
          while (container && container.tagName !== 'BODY') {
            const candidates = [...container.querySelectorAll('p, span, div')]
            for (const el of candidates as HTMLElement[]) {
              if (heading.contains(el) || el.contains(heading)) continue
              const t = el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
              if (t.length > 30) return t
            }
            container = container.parentElement
          }
          return ''
        },
        keyword,
      )
    } catch { return '' }
  }

  // Walmart
  const [title, price, highlights, description, specsTable, ingredients, rating, reviewCount] =
    await Promise.all([
      t('h1[itemprop="name"]', '[data-testid="product-title"]', 'h1'),
      t('[itemprop="price"]', '[data-testid="price-wrap"]', '.price-characteristic'),
      all('[data-testid="product-highlights"] li'),
      t('[data-testid="product-description"]', '.about-desc', '[data-testid="product-long-description"]'),
      t('[data-testid="specifications-table"]'),
      // Try testid → id → Tachyons class (Walmart specific) → h2 section walk-up
      t('[data-testid="Ingredients"]', '[id*="ingredient"]').then(
        async (v) => {
          if (v) return v
          const byClass = await page.$$eval(
            'p.mv0, p.lh-copy',
            (els, kw) => {
              const headings = [...document.querySelectorAll('h2, h3, h4')]
              const hIdx = headings.findIndex((h) =>
                h.textContent?.toLowerCase().includes((kw as string).toLowerCase()),
              )
              if (hIdx === -1) return ''
              const heading = headings[hIdx]
              for (const p of els as HTMLElement[]) {
                const pos = heading.compareDocumentPosition(p)
                if (pos & 4) {
                  const t = p.textContent?.replace(/\s+/g, ' ').trim() ?? ''
                  if (t.length > 30) return t
                }
              }
              return ''
            },
            'ingredient',
          )
          return byClass || sectionByHeading('ingredient')
        },
      ),
      // Rating: "(4.4)" span next to stars, or aria-label on the stars container
      t('div[aria-label*="stars out of"] + div .f7', 'span.f7.ph1', '.gray.flex.pl1 .f7',
        '[data-testid="rating-stars"]', '[itemprop="ratingValue"]'),
      // Review count: "912 ratings" link
      t('[itemprop="ratingCount"]', '[data-testid="item-review-section-link"]',
        '[data-testid="reviews-count"]', '[itemprop="reviewCount"]'),
    ])

  // Specs cards inside [data-testid="item-at-a-glance-genAI"]
  // Each <li> has: .b > span (label) and .ml0 > span (value)
  const specsCards = await page.$$eval(
    '[data-testid="item-at-a-glance-genAI"] li',
    (items) => (items as HTMLElement[]).map((item) => {
      const label = item.querySelector('.b span')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      const value = item.querySelector('.ml0 span')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return label && value ? `${label}: ${value}` : ''
    }).filter(Boolean),
  ).catch(() => [] as string[])

  // Reviews summary inside [data-testid="bulleted-summary"]
  // Each <li> has: button (title) + span (": description")
  const reviewsSummaryItems = await page.$$eval(
    '[data-testid="bulleted-summary"] li',
    (items) => (items as HTMLElement[]).map((item) => {
      const title = item.querySelector('button')?.textContent?.trim() ?? ''
      const desc  = item.querySelector('span')?.textContent?.replace(/^:\s*/, '').trim() ?? ''
      return title && desc ? `${title}: ${desc}` : (title || desc)
    }).filter(Boolean),
  ).catch(() => [] as string[])

  return [
    title && `TITLE: ${title}`,
    price && `PRICE: ${price}`,
    highlights.length && `HIGHLIGHTS:\n${highlights.map((h) => `- ${h}`).join('\n')}`,
    description && `DESCRIPTION:\n${description}`,
    specsTable && `SPECIFICATIONS TABLE:\n${specsTable.slice(0, 2000)}`,
    specsCards.length && `SPECS:\n${specsCards.join('\n')}`,
    ingredients && `INGREDIENTS:\n${ingredients}`,
    rating && `RATING: ${rating}`,
    reviewCount && `REVIEWS: ${reviewCount}`,
    reviewsSummaryItems.length && `REVIEWS SUMMARY:\n${reviewsSummaryItems.map((s) => `- ${s}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ── Search page: extract product URLs via CSS selectors (no LLM) ─────────────

function isProductUrl(url: string, retailer: Retailer): boolean {
  try {
    const u = new URL(url)
    if (retailer === 'amazon') {
      return (
        (u.hostname === 'www.amazon.com' || u.hostname === 'amazon.com') &&
        /\/dp\/[A-Z0-9]{10}/.test(u.pathname)
      )
    }
    if (retailer === 'walmart') {
      return (
        (u.hostname === 'www.walmart.com' || u.hostname === 'walmart.com') &&
        u.pathname.includes('/ip/')
      )
    }
  } catch {
    // invalid URL
  }
  return false
}

export async function searchRetailer(
  context: BrowserContext,
  searchUrl: string,
  retailer: Retailer,
): Promise<string[]> {
  const page = await context.newPage()
  const urls: string[] = []

  try {
    log(`Searching ${retailer}: ${searchUrl}`)
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(1500, 3000)

    if (await handleBotChallenge(page)) {
      log('Bot protection detected on search page — skipping')
      return urls
    }

    const title = await page.title()
    log(`  Page title: "${title.slice(0, 70)}"`)

    // Scroll down progressively so lazy-loaded product cards render
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let scrolled = 0
        const step = 600
        const id = setInterval(() => {
          window.scrollBy(0, step)
          scrolled += step
          if (scrolled >= document.body.scrollHeight) {
            clearInterval(id)
            resolve()
          }
        }, 120)
      })
    })
    await page.waitForTimeout(800)

    let hrefs: string[] = []

    if (retailer === 'amazon') {
      // Only organic results — data-component-type="s-search-result" excludes sp-sponsored-result
      const asins = await page.$$eval(
        '[data-component-type="s-search-result"][data-asin]:not([data-asin=""])',
        (els) => [...new Set(els.map((el) => el.getAttribute('data-asin')).filter(Boolean))],
      )
      hrefs = (asins as string[]).map((asin) => `https://www.amazon.com/dp/${asin}`)
      log(`  Selector [s-search-result data-asin] (organic only): ${hrefs.length} matches`)

      // Fallback: decode SSPA redirect URLs to find the ASIN
      if (hrefs.length === 0) {
        const rawHrefs = await page.$$eval(
          'a[href*="/dp/"], a[href*="%2Fdp%2F"]',
          (els) => [...new Set(els.map((el) => (el as HTMLAnchorElement).href).filter(Boolean))],
        )
        const asinSet = new Set<string>()
        const asinRe = /\/dp\/([A-Z0-9]{10})/
        for (const href of rawHrefs) {
          const m = decodeURIComponent(href).match(asinRe)
          if (m) asinSet.add(m[1])
        }
        hrefs = [...asinSet].map((asin) => `https://www.amazon.com/dp/${asin}`)
        log(`  Fallback [SSPA decode]: ${hrefs.length} matches`)
      }
    } else {
      hrefs = await page.$$eval(
        'a[href*="/ip/"]',
        (els) => [
          ...new Set(
            els.map((el) => (el as HTMLAnchorElement).href).filter(Boolean),
          ),
        ],
      )
      log(`  Selector [a[href*="/ip/"]]: ${hrefs.length} matches`)
    }

    for (const href of hrefs) {
      const cleanUrl = href.split('?')[0].split('#')[0]
      if (!urls.includes(cleanUrl) && isProductUrl(cleanUrl, retailer)) {
        urls.push(cleanUrl)
      }
      if (urls.length >= MAX_PRODUCTS_PER_QUERY) break
    }

    log(`  Valid product URLs: ${urls.length}`)
  } catch (err) {
    log(
      `  Error on search page: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    await page.close()
  }

  return urls
}

// ── Product detail page: extract full structured data ────────────────────────

export async function scrapeProductPage(
  context: BrowserContext,
  model: LanguageModel,
  url: string,
  retailer: Retailer,
  expectedBrand?: string,
): Promise<ScrapedProduct | null> {
  const page = await context.newPage()

  try {
    log(`  Scraping: ${url.slice(0, 90)}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS)

    if (await handleBotChallenge(page)) {
      log('  Bot protection detected on product page — skipping')
      return null
    }

    // Scroll down so lazy-loaded sections (ingredients, specs) are rendered
    if (retailer === 'walmart') {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let scrolled = 0
          const step = 700
          const id = setInterval(() => {
            window.scrollBy(0, step)
            scrolled += step
            if (scrolled >= document.body.scrollHeight) {
              clearInterval(id)
              resolve()
            }
          }, 150)
        })
      })
      await page.waitForTimeout(1200)

      // Click collapsed accordions — the toggle is div[role="button"], not the h2 inside
      const clickAccordion = async (locatorStr: string) => {
        try {
          const toggle = page.locator(locatorStr).first()
          const expanded = await toggle.getAttribute('aria-expanded').catch(() => null)
          if (expanded !== 'true' && await toggle.isVisible().catch(() => false)) {
            await toggle.click({ force: true })
            await page.waitForTimeout(800)
          }
        } catch { /* accordion not found */ }
      }
      // Specs: stable aria-label on the toggle div
      await clickAccordion('[role="button"][aria-label="Specs"]')
      // Reviews summary: no aria-label — match by text content of the toggle div
      await clickAccordion('[role="button"]:has(h2 span:text-matches("Reviews summary", "i"))')
      // Ingredients: match by text content
      await clickAccordion('[role="button"]:has(h2:text-matches("Ingredient", "i"))')
    }

    // Brand verification before spending tokens on LLM.
    // Checks (in order): URL slug → page title → DOM h1/h2.
    // Only skips if the brand name appears in none of them.
    if (expectedBrand) {
      const brand  = expectedBrand.toLowerCase()
      const inUrl  = page.url().toLowerCase().includes(brand)
      const inTitle = (await page.title()).toLowerCase().includes(brand)

      let inDom = false
      if (!inUrl && !inTitle) {
        // Last resort: check the visible product heading in the DOM
        try {
          inDom = await page.$$eval(
            'h1, h2',
            (els, b) =>
              (els as HTMLElement[]).some((el) =>
                el.textContent?.toLowerCase().includes(b as string),
              ),
            brand,
          ).catch(() => false) as boolean
        } catch { /* ignore */ }
      }

      if (!inUrl && !inTitle && !inDom) {
        log(`  Skipping: "${expectedBrand}" not in URL, title or h1/h2`)
        return null
      }
    }

    const content = await extractProductContent(page, retailer)
    if (!content.trim()) {
      log('  No content extracted — skipping')
      return null
    }

    log(`  Content size: ~${Math.round(content.length / 4)} tokens`)

    const { output: data } = await generateText({
      model,
      output: Output.object({ schema: ProductDetailSchema }),
      system: DETAIL_SYSTEM_PROMPT,
      prompt: content,
    })

    return {
      ...data,
      retailer,
      url,
      scrapedAt: new Date().toISOString(),
    }
  } catch (err) {
    log(
      `  Error scraping product: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  } finally {
    await page.close()
  }
}
