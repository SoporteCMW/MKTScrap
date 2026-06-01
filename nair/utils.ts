import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { ScrapedProduct } from './schemas.js'

export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function saveJson(data: unknown, filepath: string): void {
  writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`Saved: ${filepath}`)
}

export function saveCsv(products: ScrapedProduct[], filepath: string): void {
  if (products.length === 0) return

  const headers: Array<keyof ScrapedProduct | string> = [
    'brand',
    'productName',
    'subcategory',
    'bodyArea',
    'format',
    'claims',
    'heroIngredients',
    'price',
    'rating',
    'reviewCount',
    'isSensitiveSkin',
    'isFragranceFree',
    'isVegan',
    'innovationAxis',
    'targetConsumer',
    'isChemicalDepilatory',
    'retailer',
    'url',
    'scrapedAt',
    'fullInci',
  ]

  const escape = (v: unknown): string =>
    `"${String(v ?? '').replace(/"/g, '""')}"`

  const rows = products.map((p) =>
    [
      p.brand,
      p.productName,
      p.subcategory,
      p.bodyArea,
      p.format,
      p.claims.join(' | '),
      p.heroIngredients.join(' | '),
      p.price,
      p.rating ?? '',
      p.reviewCount ?? '',
      p.isSensitiveSkin,
      p.isFragranceFree,
      p.isVegan,
      p.innovationAxis,
      p.targetConsumer,
      p.isChemicalDepilatory,
      p.retailer,
      p.url,
      p.scrapedAt,
      p.fullInci ?? '',
    ]
      .map(escape)
      .join(','),
  )

  writeFileSync(filepath, [headers.join(','), ...rows].join('\n'), 'utf-8')
  console.log(`Saved: ${filepath}`)
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}
