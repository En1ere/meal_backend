import type { ExportDomain, ExportSectionCode, ExportSelection } from './exports.contracts.js';

export const EXPORT_MANIFEST_VERSION = '2026-10-09' as const;

type Section = readonly [ExportSectionCode, string, string];

const diarySections = [
    ['diary_entries', 'Дневник', 'Личные записи дневника, компоненты и состояния.'],
    ['diary_portions', 'Порции', 'Личные назначения порций и принятые решения.'],
] as const satisfies readonly Section[];

const financeSections = [
    ['finance_expenses', 'Расходы', 'Личные расходы и их источники.'],
    ['finance_budgets', 'Бюджеты', 'Личные бюджетные периоды и лимиты.'],
    ['finance_prices', 'Цены', 'Личные наблюдения цен и их происхождение.'],
    ['finance_receipts', 'Чеки', 'Доступные личные финансовые данные чеков без бинарных оригиналов.'],
] as const satisfies readonly Section[];

const nutritionSections = [
    ['nutrition_profile', 'Профиль питания', 'Сохранённый личный профиль без автоматических медицинских выводов.'],
    ['nutrition_targets', 'Цели и КБЖУ', 'История ручных целей и сохранённые значения питания.'],
] as const satisfies readonly Section[];

export const isProExportDomain = (domain: ExportDomain) => domain !== 'personal_data';

export const proExportSections = (domain: Exclude<ExportDomain, 'personal_data'>): readonly Section[] => {
    if (domain === 'diary') return diarySections;
    if (domain === 'finance') return financeSections;
    if (domain === 'nutrition') return nutritionSections;
    return [...diarySections, ...financeSections, ...nutritionSections];
};

export const exportDataThrough = (selection: ExportSelection, now: Date, periodEndsAt: string | null) => {
    const candidates = [selection.endsOn, now.toISOString().slice(0, 10), periodEndsAt?.slice(0, 10)].filter(
        (value): value is string => !!value,
    );
    return candidates.sort()[0]!;
};
