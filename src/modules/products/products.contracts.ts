import { z } from 'zod';

export const productUnit = z.enum(['g', 'kg', 'ml', 'l', 'pcs', 'pack', 'serv']);
export const productDecimal = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/);
const nutrition = z.strictObject({
    kcal: productDecimal.nullable(),
    protein: productDecimal.nullable(),
    fat: productDecimal.nullable(),
    carbs: productDecimal.nullable(),
    basisQuantity: productDecimal,
    basisUnit: productUnit,
    source: z.string(),
    confidence: productDecimal.nullable(),
    compositionText: z.string().nullable(),
});
const allergen = z.strictObject({
    code: z.string(),
    name: z.string(),
    status: z.enum(['contains', 'may_contain', 'unknown']),
    source: z.string(),
});
export const productSummarySchema = z.strictObject({
    id: z.uuid(),
    name: z.string(),
    categoryCode: z.string(),
    defaultUnit: productUnit,
    status: z.enum(['approved', 'pending']),
    owned: z.boolean(),
});
export const productDetailSchema = productSummarySchema.extend({
    version: z.number().int().positive(),
    aliases: z.array(z.string()),
    nutrition: nutrition.nullable(),
    allergens: z.array(allergen),
    variants: z.array(
        z.strictObject({
            id: z.uuid(),
            name: z.string(),
            products: z.array(
                z.strictObject({
                    id: z.uuid(),
                    name: z.string(),
                    brand: z.string().nullable(),
                    packageQuantity: productDecimal.nullable(),
                    packageUnit: productUnit,
                    barcodes: z.array(z.string()),
                    nutrition: nutrition.nullable(),
                    allergens: z.array(allergen),
                }),
            ),
        }),
    ),
    provenance: z.string(),
    proposalId: z.uuid().nullable(),
});
export const productListSchema = z.strictObject({
    items: z.array(productSummarySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
});
export const productResultSchema = z.strictObject({ product: productDetailSchema });
export const productReferenceSchema = z.strictObject({
    categories: z.array(z.strictObject({ id: z.uuid(), code: z.string(), name: z.string() })),
    allergens: z.array(z.strictObject({ code: z.string(), name: z.string() })),
});
export const productSearchSchema = z.strictObject({
    q: z.string().trim().max(200).default(''),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    barcode: z
        .string()
        .regex(/^\d{8,14}$/)
        .optional(),
});
export const productProposalSchema = z.strictObject({
    idempotencyKey: z.uuid(),
    name: z.string().trim().min(1).max(200),
    categoryId: z.uuid(),
    unit: productUnit,
    brand: z.string().trim().min(1).max(120).nullable(),
    packageQuantity: productDecimal.nullable(),
    barcode: z
        .string()
        .regex(/^\d{8,14}$/)
        .nullable(),
    compositionText: z.string().trim().max(10000).nullable(),
    kcal: productDecimal.nullable(),
    protein: productDecimal.nullable(),
    fat: productDecimal.nullable(),
    carbs: productDecimal.nullable(),
    nutritionBasisUnit: z.enum(['g', 'ml']),
    allergens: z
        .array(
            z.strictObject({ code: z.string().min(1).max(60), status: z.enum(['contains', 'may_contain', 'unknown']) }),
        )
        .max(64),
    source: z.enum(['user', 'ocr']).default('user'),
    sourceText: z.string().max(20000).nullable().default(null),
});
export type ProductProposal = z.infer<typeof productProposalSchema>;
export type ProductDetail = z.infer<typeof productDetailSchema>;
export type ProductSearch = z.infer<typeof productSearchSchema>;

export function validProductBarcode(code: string): boolean {
    if (![8, 12, 13, 14].includes(code.length) || !/^\d+$/.test(code)) return false;
    let sum = 0;
    for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(code[i]) * weight;
    return (10 - (sum % 10)) % 10 === Number(code.at(-1));
}
