import { z } from 'zod';

const moneySchema = z.string().regex(/^\d{1,7}(?:\.\d{1,8})?$/);

export const AI_PROVIDER_PROFILES = {
    'openai-gpt-6-luna-standard-2026-11-07': {
        provider: 'openai',
        model: 'gpt-6-luna',
        serviceTier: 'standard',
        inputUsdPerMillionTokens: '0.10',
        outputUsdPerMillionTokens: '0.50',
    },
    'openai-gpt-6.1-sol-standard-2026-11-07': {
        provider: 'openai',
        model: 'gpt-6.1-sol',
        serviceTier: 'standard',
        inputUsdPerMillionTokens: '2.00',
        outputUsdPerMillionTokens: '10.00',
    },
} as const;

export type AiProviderProfileVersion = keyof typeof AI_PROVIDER_PROFILES;
export type AiProviderProfile = (typeof AI_PROVIDER_PROFILES)[AiProviderProfileVersion];

const profileVersionSchema = z.enum(
    Object.keys(AI_PROVIDER_PROFILES) as [AiProviderProfileVersion, ...AiProviderProfileVersion[]],
);

const decimalUnits = (value: string) => {
    const parsed = moneySchema.parse(value);
    const [whole, fraction = ''] = parsed.split('.');
    return BigInt(whole ?? '0') * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
};

export const aiFormatMoneyUnits = (units: bigint) => {
    if (units < 0n) throw new Error('AI money cannot be negative');
    const whole = units / 100_000_000n;
    const fraction = (units % 100_000_000n).toString().padStart(8, '0');
    return `${whole}.${fraction}`;
};

export function aiProviderProfile(version: string): AiProviderProfile & { version: AiProviderProfileVersion } {
    const resolved = profileVersionSchema.parse(version);
    return { version: resolved, ...AI_PROVIDER_PROFILES[resolved] };
}

export function aiMoneyUnits(value: string) {
    return decimalUnits(value);
}

export function aiProviderCost(
    profile: Pick<AiProviderProfile, 'inputUsdPerMillionTokens' | 'outputUsdPerMillionTokens'>,
    usage: { inputTokens: number; outputTokens: number },
) {
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0) throw new Error('Invalid AI input usage');
    if (!Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) throw new Error('Invalid AI output usage');
    const inputRateUnits = decimalUnits(profile.inputUsdPerMillionTokens);
    const outputRateUnits = decimalUnits(profile.outputUsdPerMillionTokens);
    const numerator = BigInt(usage.inputTokens) * inputRateUnits + BigInt(usage.outputTokens) * outputRateUnits;
    return aiFormatMoneyUnits((numerator + 999_999n) / 1_000_000n);
}
