import type { RecipeIngredient } from './recipes.contracts.js';
export interface RecipeStock {
    ingredientId: string | null;
    variantId: string | null;
    productId: string | null;
    sourceRecipeId: string | null;
    quantity: string | null;
    unit: string | null;
}
const decimal = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole ?? '0') * 100000000n + BigInt(fraction.padEnd(8, '0'));
};
export function recipeDecimalText(value: bigint): string {
    const whole = value / 100000000n;
    const fraction = (value % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole}${fraction ? '.' + fraction : ''}`;
}
export function scaleRecipeQuantity(value: string | null, baseServings: number, servings: number): string | null {
    if (value === null) return null;
    const denominator = BigInt(baseServings);
    const numerator = decimal(value) * BigInt(servings);
    return recipeDecimalText((numerator + denominator - 1n) / denominator);
}
function factor(unit: string | null): { dimension: string; factor: bigint } | null {
    if (unit === 'g') return { dimension: 'mass', factor: 1n };
    if (unit === 'kg') return { dimension: 'mass', factor: 1000n };
    if (unit === 'ml') return { dimension: 'volume', factor: 1n };
    if (unit === 'l') return { dimension: 'volume', factor: 1000n };
    return unit ? { dimension: unit, factor: 1n } : null;
}
export function recipeAvailability(
    ingredients: RecipeIngredient[],
    stocks: RecipeStock[],
    baseServings: number,
    servings: number,
) {
    const items = ingredients.map((line) => {
        const requiredQuantity = scaleRecipeQuantity(line.quantity, baseServings, servings);
        const matches = stocks.filter(
            (stock) =>
                (stock.quantity === null || decimal(stock.quantity) > 0n) &&
                (line.productId
                    ? stock.productId === line.productId
                    : line.variantId
                      ? stock.variantId === line.variantId
                      : line.ingredientId
                        ? stock.ingredientId === line.ingredientId
                        : line.sourceRecipeId
                          ? stock.sourceRecipeId === line.sourceRecipeId
                          : false),
        );
        const target = factor(line.unit);
        let total = 0n;
        let uncertain = matches.length === 0;
        for (const stock of matches) {
            const source = factor(stock.unit);
            if (stock.quantity === null || !target || !source || source.dimension !== target.dimension) {
                uncertain = true;
                continue;
            }
            total += decimal(stock.quantity) * source.factor;
        }
        if (target) total /= target.factor;
        const availableQuantity = uncertain ? null : recipeDecimalText(total);
        return {
            id: line.id,
            requiredQuantity,
            availableQuantity,
            unit: line.unit,
            present: matches.length > 0,
            optional: line.optional,
            needsQuantityCheck:
                matches.length > 0 && (uncertain || requiredQuantity === null || total < decimal(requiredQuantity)),
        };
    });
    const required = items.filter((row) => !row.optional),
        presentCount = required.filter((row) => row.present).length,
        requiredCount = required.length;
    return {
        requiredCount,
        presentCount,
        presencePercent: requiredCount ? Math.round((presentCount / requiredCount) * 10000) / 100 : 100,
        canPrepare: requiredCount === 0 || presentCount * 5 >= requiredCount * 4,
        needsQuantityCheck: required.some((row) => row.needsQuantityCheck),
        items,
    };
}
export function publicRecipeImage(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (/^\/(?:recipes|assets)\/[A-Za-z0-9/_\.\-]+$/.test(value) && !value.includes('..')) return value;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}
