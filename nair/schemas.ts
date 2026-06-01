import { z } from 'zod'

// ── Search results page ──────────────────────────────────────────────────────
// Used to extract the list of product URLs from a search page (Amazon / Walmart)

export const SearchListSchema = z.object({
  products: z
    .array(
      z.object({
        name: z.string().describe('Product title as shown in the listing'),
        brand: z.string().describe('Brand name if identifiable, else "Unknown"'),
        url: z
          .string()
          .describe(
            'Full absolute URL to the product detail page (include https://)',
          ),
        price: z.string().optional().describe('Price as shown, e.g. "$8.99"'),
        rating: z.number().optional().describe('Star rating 0-5'),
        reviewCount: z.number().optional(),
        looksLikeChemicalDepilatory: z
          .boolean()
          .describe(
            'TRUE if this looks like a cream/gel/mask/lotion that chemically dissolves hair. FALSE for wax, razor, epilator, IPL, shaving cream, hair inhibitor.',
          ),
      }),
    )
    .describe('All hair removal products visible on the page'),
})

// ── Product detail page ──────────────────────────────────────────────────────
// Used to extract full structured data from an individual product page

export const ProductDetailSchema = z.object({
  brand: z.string().describe('Brand name, e.g. "Nair", "Veet"'),
  productName: z.string().describe('Full product name as on the page'),

  subcategory: z
    .enum([
      'body',
      'facial',
      'bikini_intimate',
      'mens',
      'in_shower',
      'sensitive',
      'general',
    ])
    .describe(
      'Most specific subcategory: body=legs/arms/full body, facial=upper lip/chin/face, bikini_intimate=bikini line/intimate, mens=men-targeted, in_shower=shower-compatible format, sensitive=sensitive skin line, general=multi-use',
    ),

  bodyArea: z
    .string()
    .describe(
      'Target body area(s): e.g. "legs", "arms", "face", "bikini line", "underarms", "full body", "upper lip"',
    ),

  format: z
    .enum([
      'cream',
      'mask',
      'gel',
      'lotion',
      'mousse_foam',
      'spray',
      'roll_on',
      'powder',
      'other',
    ])
    .describe('Physical product format / texture'),

  claims: z
    .array(z.string())
    .describe(
      'All marketing claims on the product: "painless", "odor-free", "sensitive skin", "dermatologist tested", "in 3 minutes", "vegan", etc.',
    ),

  heroIngredients: z
    .array(z.string())
    .describe(
      'Ingredients highlighted in marketing copy: "aloe vera", "hyaluronic acid", "oat extract", "argan oil", etc.',
    ),

  fullInci: z
    .string()
    .optional()
    .describe('Full ingredient list (INCI) if visible on the page'),

  price: z.string().describe('Price as shown, e.g. "$9.47"'),

  rating: z.number().optional().describe('Average star rating, e.g. 4.4'),
  reviewCount: z.number().optional().describe('Total number of reviews/ratings, e.g. 912'),

  specs: z
    .record(z.string(), z.string())
    .optional()
    .describe('Key-value pairs from the Specs section, e.g. {"Hair removal depilator type": "Hair Dissolving Agent"}'),

  reviewsSummary: z
    .array(z.string())
    .optional()
    .describe('AI-generated review summary bullet points visible under "Reviews summary"'),

  isSensitiveSkin: z
    .boolean()
    .describe('True if the product is specifically marketed for sensitive skin'),
  isFragranceFree: z.boolean().describe('True if fragrance-free is claimed'),
  isVegan: z.boolean().describe('True if vegan claim is present'),

  innovationAxis: z
    .string()
    .describe(
      'Primary innovation/differentiator: e.g. "skincare-infused", "low-odor", "rapid-action (3 min)", "sensitive", "mens grooming", "bikini precision", "in-shower", "premiumization"',
    ),

  targetConsumer: z
    .string()
    .describe(
      'Primary target consumer: e.g. "women 18-35", "men", "sensitive skin", "teens", "mature women"',
    ),

  isChemicalDepilatory: z
    .boolean()
    .describe(
      'TRUE only if the product uses thioglycolate or equivalent chemical depilatory active to dissolve hair. FALSE for wax, razors, epilators, IPL, shaving cream without depilatory active, hair inhibitors.',
    ),
})

// Full record saved to disk (schema fields + metadata we inject)
export type ScrapedProduct = z.infer<typeof ProductDetailSchema> & {
  retailer: 'amazon' | 'walmart'
  url: string
  scrapedAt: string
}

export type SearchList = z.infer<typeof SearchListSchema>
