import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { aiMoneyUnits } from '../../shared/config/ai-provider-profile.js';
import { aiV4ProviderProfiles } from './ai-policy-v4.js';

export const YANDEX_AI_ENDPOINT = 'https://ai.api.cloud.yandex.net/v1/' as const;

const optionalNonEmpty = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
);
const optionalBoolean = z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true');
const cloudIdentity = z.string().regex(/^[a-z0-9]{10,50}$/);
const optionalMoney = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
        .string()
        .regex(/^\d{1,7}(?:\.\d{1,8})?$/)
        .optional(),
);

const schema = z.strictObject({
    YANDEX_AI_ENABLED: optionalBoolean,
    YANDEX_AI_STORE_FALSE_READBACK_VERIFIED: optionalBoolean,
    YANDEX_AI_API_KEY_FILE: optionalNonEmpty,
    YANDEX_AI_ENDPOINT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(YANDEX_AI_ENDPOINT).optional(),
    ),
    YANDEX_AI_FOLDER_ID: z.preprocess((value) => (value === '' ? undefined : value), cloudIdentity.optional()),
    YANDEX_AI_SERVICE_ACCOUNT_ID: z.preprocess((value) => (value === '' ? undefined : value), cloudIdentity.optional()),
    YANDEX_AI_ECONOMY_PROFILE_VERSION: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(aiV4ProviderProfiles.economy.version).optional(),
    ),
    YANDEX_AI_BALANCED_PROFILE_VERSION: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(aiV4ProviderProfiles.balanced.version).optional(),
    ),
    YANDEX_AI_MONTHLY_BUDGET_RUB: optionalMoney,
    YANDEX_AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
});

const expectedFields = [
    'YANDEX_AI_API_KEY_FILE',
    'YANDEX_AI_ENDPOINT',
    'YANDEX_AI_FOLDER_ID',
    'YANDEX_AI_SERVICE_ACCOUNT_ID',
    'YANDEX_AI_ECONOMY_PROFILE_VERSION',
    'YANDEX_AI_BALANCED_PROFILE_VERSION',
    'YANDEX_AI_MONTHLY_BUDGET_RUB',
    'YANDEX_AI_STORE_FALSE_READBACK_VERIFIED',
] as const;

function readSecret(file: string) {
    if (!isAbsolute(file)) throw new Error('YANDEX_AI_API_KEY_FILE must be an absolute path');
    let value: string;
    try {
        value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
        throw new Error('Unable to read YANDEX_AI_API_KEY_FILE');
    }
    if (!value || /[\r\n\0]/.test(value)) throw new Error('YANDEX_AI_API_KEY_FILE must contain one non-empty line');
    return value;
}

export type YandexAiReadiness = 'unconfigured' | 'disabled' | 'ready';

export type YandexAiAdapterConfig = ReturnType<typeof readYandexAiAdapterConfig>;

export function readYandexAiAdapterConfig(env: NodeJS.ProcessEnv) {
    if (env.YANDEX_AI_API_KEY) throw new Error('Yandex AI secret must use YANDEX_AI_API_KEY_FILE');
    const selected = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('YANDEX_AI_')));
    const value = schema.parse(selected);
    const missing = expectedFields.filter((field) => {
        if (field === 'YANDEX_AI_STORE_FALSE_READBACK_VERIFIED') return !value.YANDEX_AI_STORE_FALSE_READBACK_VERIFIED;
        return value[field] === undefined;
    });
    const budgetUnits = value.YANDEX_AI_MONTHLY_BUDGET_RUB ? aiMoneyUnits(value.YANDEX_AI_MONTHLY_BUDGET_RUB) : null;
    if (budgetUnits !== null && budgetUnits <= 0n)
        throw new Error('YANDEX_AI_MONTHLY_BUDGET_RUB must be greater than zero');
    const apiKey = value.YANDEX_AI_API_KEY_FILE ? readSecret(value.YANDEX_AI_API_KEY_FILE) : null;
    const complete = missing.length === 0 && apiKey !== null && budgetUnits !== null;
    const readiness: YandexAiReadiness = !complete ? 'unconfigured' : value.YANDEX_AI_ENABLED ? 'ready' : 'disabled';
    const folderId = value.YANDEX_AI_FOLDER_ID ?? null;
    return {
        enabled: readiness === 'ready',
        readiness,
        missing,
        endpoint: value.YANDEX_AI_ENDPOINT ?? null,
        folderId,
        serviceAccountId: value.YANDEX_AI_SERVICE_ACCOUNT_ID ?? null,
        monthlyBudgetRub: value.YANDEX_AI_MONTHLY_BUDGET_RUB ?? null,
        monthlyBudgetUnits: budgetUnits,
        timeoutMs: value.YANDEX_AI_TIMEOUT_MS,
        store: false as const,
        profiles:
            folderId && value.YANDEX_AI_ECONOMY_PROFILE_VERSION && value.YANDEX_AI_BALANCED_PROFILE_VERSION
                ? {
                      [value.YANDEX_AI_ECONOMY_PROFILE_VERSION]: {
                          model: `gpt://${folderId}/aliceai-llm-flash`,
                          ...aiV4ProviderProfiles.economy,
                      },
                      [value.YANDEX_AI_BALANCED_PROFILE_VERSION]: {
                          model: `gpt://${folderId}/yandexgpt-5.1`,
                          ...aiV4ProviderProfiles.balanced,
                      },
                  }
                : null,
        apiKey,
    };
}
