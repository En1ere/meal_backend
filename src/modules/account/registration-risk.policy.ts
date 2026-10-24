import { z } from 'zod';
import type { AppConfig } from '../../app/config.js';

export const registrationRiskConfigSchema = z.strictObject({
    enabled: z.boolean().default(false),
    providerFailureMode: z.enum(['fail_closed', 'fail_open']).default('fail_closed'),
    disposableEmailCheck: z.boolean().default(true),
    captcha: z.enum(['disabled', 'risk_based', 'always']).default('risk_based'),
    denyRiskScoreAtOrAbove: z.number().min(0).max(1).default(0.9),
});
export type RegistrationRiskConfig = z.infer<typeof registrationRiskConfigSchema>;
export type RegistrationRiskInput = {
    email: string;
    ip: string;
    captchaToken?: string;
};
export type RegistrationRiskSignal = {
    disposableEmail: boolean;
    riskScore: number;
    captchaPassed: boolean | null;
};
export type RegistrationRiskDecision =
    | { allowed: true; reason: 'disabled' | 'accepted' | 'provider_unavailable_fail_open' }
    | { allowed: false; reason: 'disposable_email' | 'risk_threshold' | 'captcha_required' | 'provider_unavailable' };

export interface RegistrationRiskProvider {
    assess(input: RegistrationRiskInput): Promise<RegistrationRiskSignal>;
}

/** Provider-neutral policy. It never guesses a blocklist result or treats a missing CAPTCHA as passed. */
export class RegistrationRiskPolicy {
    constructor(
        private readonly config: RegistrationRiskConfig,
        private readonly provider: RegistrationRiskProvider | null,
    ) {}

    async evaluate(input: RegistrationRiskInput): Promise<RegistrationRiskDecision> {
        if (!this.config.enabled) return { allowed: true, reason: 'disabled' };
        if (!this.provider)
            return this.config.providerFailureMode === 'fail_open'
                ? { allowed: true, reason: 'provider_unavailable_fail_open' }
                : { allowed: false, reason: 'provider_unavailable' };
        let signal: RegistrationRiskSignal;
        try {
            signal = await this.provider.assess(input);
        } catch {
            return this.config.providerFailureMode === 'fail_open'
                ? { allowed: true, reason: 'provider_unavailable_fail_open' }
                : { allowed: false, reason: 'provider_unavailable' };
        }
        if (this.config.disposableEmailCheck && signal.disposableEmail)
            return { allowed: false, reason: 'disposable_email' };
        if (signal.riskScore >= this.config.denyRiskScoreAtOrAbove) return { allowed: false, reason: 'risk_threshold' };
        const captchaRequired =
            this.config.captcha === 'always' || (this.config.captcha === 'risk_based' && signal.riskScore > 0);
        if (captchaRequired && signal.captchaPassed !== true) return { allowed: false, reason: 'captcha_required' };
        return { allowed: true, reason: 'accepted' };
    }
}

export function registrationRiskConfig(config: AppConfig): RegistrationRiskConfig {
    return registrationRiskConfigSchema.parse({
        enabled: config.REGISTRATION_RISK_ENABLED,
        providerFailureMode: config.REGISTRATION_RISK_FAILURE_MODE,
        disposableEmailCheck: config.REGISTRATION_DISPOSABLE_EMAIL_CHECK,
        captcha: config.REGISTRATION_CAPTCHA_MODE,
        denyRiskScoreAtOrAbove: config.REGISTRATION_DENY_RISK_SCORE,
    });
}
