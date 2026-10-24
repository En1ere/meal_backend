import type { DiaryComponent, DiaryEntry } from './diary.contracts.js';
import { decimal, decimalText } from '../inventory/inventory.domain.js';

export type PortionState = 'pending' | 'confirmed' | 'auto_confirmed' | 'refused' | 'cancelled';
export type PortionDecision = 'confirmed' | 'refused' | 'cancelled';

export function portionTransition(state: PortionState, decision: PortionDecision, due: boolean) {
    const effective = state === 'pending' && due ? ('auto_confirmed' as const) : state;
    if (effective === 'pending' && (decision === 'confirmed' || decision === 'refused'))
        return {
            effective,
            next: decision,
            method: decision === 'confirmed' ? ('manual' as const) : ('refused' as const),
        };
    if (effective === 'auto_confirmed' && decision === 'cancelled')
        return { effective, next: decision, method: 'cancelled' as const };
    return null;
}

export const unknownNutrition = (): DiaryEntry['nutrition'] => ({
    energyKcal: null,
    proteinG: null,
    fatG: null,
    carbohydrateG: null,
    fiberG: null,
});

export function completeness(nutrition: ReturnType<typeof unknownNutrition>) {
    const count = Object.values(nutrition).filter((value) => value !== null).length;
    return count === 0 ? ('unknown' as const) : count === 5 ? ('complete' as const) : ('partial' as const);
}

export function scaleNutrition(raw: Record<string, unknown>, quantity: string, basis: string): DiaryEntry['nutrition'] {
    const ratio = (value: unknown): string | null => {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const normalized = String(value);
        if (!/^\d+(\.\d{1,8})?$/.test(normalized) || decimal(basis) === 0n) return null;
        return decimalText((decimal(normalized) * decimal(quantity)) / decimal(basis));
    };
    return {
        energyKcal: ratio(raw.energyKcal ?? raw.energy_kcal ?? raw.kcal),
        proteinG: ratio(raw.proteinG ?? raw.protein_g ?? raw.protein),
        fatG: ratio(raw.fatG ?? raw.fat_g ?? raw.fat),
        carbohydrateG: ratio(raw.carbohydrateG ?? raw.carbohydrate_g ?? raw.carbs),
        fiberG: ratio(raw.fiberG ?? raw.fiber_g ?? raw.fiber),
    };
}

export function aggregateNutrition(components: Pick<DiaryComponent, 'nutrition'>[]) {
    if (!components.length) return unknownNutrition();
    const keys = Object.keys(unknownNutrition()) as (keyof ReturnType<typeof unknownNutrition>)[];
    return Object.fromEntries(
        keys.map((key) => {
            const values = components.map((component) => component.nutrition[key]);
            return [
                key,
                values.some((value) => value === null)
                    ? null
                    : decimalText(values.reduce((sum, value) => sum + decimal(value!), 0n)),
            ];
        }),
    ) as DiaryEntry['nutrition'];
}
