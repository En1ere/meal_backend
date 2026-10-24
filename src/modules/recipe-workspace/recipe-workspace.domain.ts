import { recipeNutritionSchema } from '../recipes/recipes.contracts.js';
import type { WorkspaceDocument } from './recipe-workspace.contracts.js';
import { workspaceNutritionSchema } from './recipe-workspace.contracts.js';
const scale = 100000000n;
export function workspaceIngredientSource(line: {
    productId?: unknown;
    variantId?: unknown;
    ingredientId?: unknown;
    sourceRecipeId?: unknown;
}) {
    const productId = typeof line.productId === 'string' ? line.productId : null;
    const variantId = !productId && typeof line.variantId === 'string' ? line.variantId : null;
    const ingredientId = !productId && !variantId && typeof line.ingredientId === 'string' ? line.ingredientId : null;
    const sourceRecipeId =
        !productId && !variantId && !ingredientId && typeof line.sourceRecipeId === 'string'
            ? line.sourceRecipeId
            : null;
    return { productId, variantId, ingredientId, sourceRecipeId };
}
function decimal(s: string) {
    const [a, b = ''] = s.split('.');
    return BigInt(a!) * scale + BigInt(b.padEnd(8, '0').slice(0, 8));
}
function format(n: bigint) {
    return `${n / scale}.${(n % scale).toString().padStart(8, '0')}`.replace(/\.?0+$/, '');
}
export type WorkspaceComposition = {
    kcal: string | null;
    protein: string | null;
    fat: string | null;
    carbs: string | null;
    quantity: string;
    unit: string;
};
export function workspaceNutrition(
    document: WorkspaceDocument,
    compositions: Array<WorkspaceComposition | null>,
    previous: unknown,
) {
    const fields = ['kcal', 'protein', 'fat', 'carbs'] as const;
    const totals = { kcal: 0n, protein: 0n, fat: 0n, carbs: 0n };
    const missing: string[] = [];
    for (const [i, line] of document.ingredients.entries()) {
        const c = compositions[i];
        const key = line.productId ?? line.variantId ?? line.ingredientId ?? line.sourceRecipeId ?? String(i);
        const units: Record<string, { dimension: string; factor: bigint }> = {
            g: { dimension: 'mass', factor: 1n },
            kg: { dimension: 'mass', factor: 1000n },
            ml: { dimension: 'volume', factor: 1n },
            l: { dimension: 'volume', factor: 1000n },
        };
        const from = line.unit ? units[line.unit] : undefined,
            to = c ? units[c.unit] : undefined;
        if (
            !c ||
            !line.quantity ||
            !line.unit ||
            fields.some((f) => c[f] === null) ||
            decimal(c.quantity) <= 0n ||
            (line.unit !== c.unit && (!from || !to || from.dimension !== to.dimension))
        ) {
            missing.push(key);
            continue;
        }
        const numerator = decimal(line.quantity) * (from?.factor ?? 1n),
            denominator = decimal(c.quantity) * (to?.factor ?? 1n);
        for (const f of fields) totals[f] += (decimal(c[f]!) * numerator) / denominator;
    }
    if (document.ingredients.length && !missing.length) {
        const result = recipeNutritionSchema.safeParse({
            ...Object.fromEntries(fields.map((f) => [f, format(totals[f])])),
            basis: 'recipe',
        });
        if (result.success) return { status: 'calculated' as const, base: result.data, uncoveredIngredientIds: [] };
    }
    const wrapped = workspaceNutritionSchema.safeParse(previous),
        raw = recipeNutritionSchema.safeParse(previous);
    const base = wrapped.success ? wrapped.data.base : raw.success ? raw.data : null;
    return {
        status: base ? ('base-unadjusted' as const) : ('unavailable' as const),
        base,
        uncoveredIngredientIds: missing,
    };
}
