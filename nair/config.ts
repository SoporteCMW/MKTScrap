// All brands to track
export const BRANDS = [
  'Veet',
  "Nad's",
  'Flamingo',
  'Billie',
  'Completely Bare',
  'No Hair Crew',
  'Surgi Cream',
  'GiGi',
  'Avon Skin So Soft Hair Removal',
  'SoftSheen-Carson Magic Razorless',
]

// Category-level queries — combined with each brand in full mode: "{brand} {categoryQuery}"
export const CATEGORY_QUERIES = [
  'depilatory cream hair removal',
  'hair removal mask depilatory',
  'facial chemical depilatory hair removal',
  'body hair removal depilatory cream',
  'bikini intimate hair removal depilatory',
  'sensitive skin hair removal cream depilatory',
  'mens hair removal depilatory cream',
  'in-shower hair removal cream',
  'rapid action fast hair removal cream',
  'razorless chemical shave cream powder',
  'hair removal gel lotion mousse depilatory',
]

// Legacy flat list kept for --brands / --test CLI modes
export const SEARCH_QUERIES = CATEGORY_QUERIES

export const RETAILERS = {
  amazon: (q: string) =>
    `https://www.amazon.com/s?k=${encodeURIComponent(q)}&i=beauty`,
  walmart: (q: string) =>
    `https://www.walmart.com/search?q=${encodeURIComponent(q)}&cat_id=1085666`,
} as const

export type Retailer = keyof typeof RETAILERS

// Max product URLs collected per brand×category search (deduped globally)
export const MAX_PRODUCTS_PER_BRAND_QUERY = 6

// Hard cap: max products scraped per brand (across all category queries)
export const MAX_PRODUCTS_PER_BRAND = 30

// Max product URLs to follow per search query (used in --brands / --test modes)
export const MAX_PRODUCTS_PER_QUERY = 24

// Delay between page loads to avoid rate limiting (ms)
export const DELAY_MIN_MS = 2500
export const DELAY_MAX_MS = 5500

// Where results are saved (relative to llm-scraper/)
export const OUTPUT_DIR = 'nair/output'
