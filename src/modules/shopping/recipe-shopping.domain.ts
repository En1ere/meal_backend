import { decimal, decimalText } from '../inventory/public.js';

const SCALE = 100_000_000n;

export type RecipeShoppingSourceLine = {
    lineId: string;
    position: number;
    name: string;
    quantity: string | null;
    ingredientId: string | null;
    variantId: string | null;
    productId: string | null;
    sourceRecipeId: string | null;
    unitId: string | null;
    unit: string | null;
    unitDimension: string | null;
    unitFactor: string | null;
    unitApproximate: boolean | null;
    baseUnit: string | null;
    revisionId: string;
    portions: number;
};

export type RecipeShoppingPreviewItem = {
    name: string;
    quantity: string | null;
    unit: string | null;
    ingredientId: string | null;
    productId: string | null;
    allowAnalog: boolean;
    recipeOrigin: Array<{ revisionId: string; portions: number; quantity: string | null }>;
    requirements: Record<string, string>;
    estimatedPriceMinor: null;
    needsQuantityCheck: boolean;
};

type NormalizedLine = RecipeShoppingSourceLine & {
    identity: string;
    groupKey: string;
    normalizedQuantity: string | null;
    normalizedUnit: string | null;
};

function identity(line: RecipeShoppingSourceLine) {
    if (line.productId) return `product:${line.productId}`;
    if (line.variantId) return `variant:${line.variantId}`;
    if (line.ingredientId) return `ingredient:${line.ingredientId}`;
    if (line.sourceRecipeId) return `recipe:${line.sourceRecipeId}`;
    return `line:${line.lineId}`;
}

function exactBaseQuantity(line: RecipeShoppingSourceLine): { quantity: string; unit: string } | null {
    if (
        line.quantity === null ||
        line.unit === null ||
        line.unitDimension === null ||
        line.unitFactor === null ||
        line.unitApproximate !== false ||
        line.baseUnit === null
    )
        return null;
    const numerator = decimal(line.quantity) * decimal(line.unitFactor);
    return { quantity: decimalText((numerator + SCALE - 1n) / SCALE), unit: line.baseUnit };
}

function normalize(line: RecipeShoppingSourceLine): NormalizedLine {
    const sourceIdentity = identity(line);
    const converted = exactBaseQuantity(line);
    const normalizedUnit = converted?.unit ?? line.unit;
    const compatibility = converted
        ? `dimension:${line.unitDimension}`
        : line.unitId
          ? `unit:${line.unitId}`
          : 'unit:none';
    return {
        ...line,
        identity: sourceIdentity,
        groupKey: `${sourceIdentity}:${compatibility}`,
        normalizedQuantity: line.quantity === null ? null : (converted?.quantity ?? line.quantity),
        normalizedUnit,
    };
}

export function aggregateRecipeShoppingLines(lines: readonly RecipeShoppingSourceLine[]) {
    const normalized = [...lines]
        .map(normalize)
        .sort((left, right) =>
            [left.identity, left.groupKey, left.revisionId, left.position, left.lineId]
                .join(':')
                .localeCompare(
                    [right.identity, right.groupKey, right.revisionId, right.position, right.lineId].join(':'),
                ),
        );
    const groups = new Map<string, NormalizedLine[]>();
    for (const line of normalized) groups.set(line.groupKey, [...(groups.get(line.groupKey) ?? []), line]);

    const compatibilityByIdentity = new Map<string, Set<string>>();
    for (const line of normalized) {
        const keys = compatibilityByIdentity.get(line.identity) ?? new Set<string>();
        keys.add(line.groupKey);
        compatibilityByIdentity.set(line.identity, keys);
    }

    const items: RecipeShoppingPreviewItem[] = [];
    for (const group of groups.values()) {
        const first = group[0]!;
        const unknown = group.some((line) => line.normalizedQuantity === null);
        const quantity = unknown
            ? null
            : decimalText(group.reduce((sum, line) => sum + decimal(line.normalizedQuantity!), 0n));
        items.push({
            name: first.name,
            quantity,
            unit: first.normalizedUnit,
            ingredientId: first.ingredientId,
            productId: first.productId,
            allowAnalog: first.productId === null,
            recipeOrigin: group.map((line) => ({
                revisionId: line.revisionId,
                portions: line.portions,
                quantity: line.normalizedQuantity,
            })),
            requirements: {},
            estimatedPriceMinor: null,
            needsQuantityCheck: unknown,
        });
    }

    return {
        items,
        quantityCheckRequired: items.some((item) => item.needsQuantityCheck),
        incompatibleUnitsPreserved: [...compatibilityByIdentity.values()].some((keys) => keys.size > 1),
    };
}
