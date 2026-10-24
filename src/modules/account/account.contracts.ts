import { z } from 'zod';
import { registrationLegalEvidenceSchema } from '../legal-consents/legal-consent.contracts.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
    .string()
    .min(12)
    .max(128)
    .regex(/^(?=[\s\S]*\p{Ll})(?=[\s\S]*\p{Lu})(?=[\s\S]*\p{N})(?=[\s\S]*[^\p{L}\p{N}\s])[\s\S]*$/u);
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const factorProofSchema = z.strictObject({
    method: z.enum(['totp', 'recovery']),
    code: z.string().min(6).max(64),
});
export const accountInputs = {
    register: z.strictObject({
        username: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_]{3,30}$/)
            .toLowerCase(),
        displayName: z.string().trim().min(1).max(100),
        email: emailSchema,
        password: passwordSchema,
        acceptTerms: z.literal(true),
        acceptPrivacy: z.literal(true),
    }),
    registerV2: z.strictObject({
        username: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_]{3,30}$/)
            .toLowerCase(),
        displayName: z.string().trim().min(1).max(100),
        email: emailSchema,
        password: passwordSchema,
        legal: registrationLegalEvidenceSchema,
    }),
    verify: z.strictObject({ token: tokenSchema }),
    resend: z.strictObject({ email: emailSchema }),
    recovery: z.strictObject({ email: emailSchema }),
    resetCheck: z.strictObject({ token: tokenSchema }),
    reset: z.strictObject({ token: tokenSchema, password: passwordSchema }),
    passwordChange: z.strictObject({ currentPassword: z.string().min(1).max(1024), password: passwordSchema }),
    emailChange: z.strictObject({ password: z.string().min(1).max(1024), email: emailSchema }),
    emailConfirm: z.strictObject({ token: tokenSchema }),
    emailCancel: z.strictObject({ token: tokenSchema }),
    totpLogin: z.strictObject({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }),
    pinSetup: z.strictObject({ password: z.string().min(1).max(1024), pin: z.string().regex(/^\d{6}$/) }),
    pinLogin: z.strictObject({ pin: z.string().regex(/^\d{6}$/) }),
    pinRevoke: z.strictObject({}),
    authenticatorSetup: z.strictObject({ password: z.string().min(1).max(1024), proof: factorProofSchema.optional() }),
    authenticatorConfirm: z.strictObject({ challenge: tokenSchema, code: z.string().regex(/^\d{6}$/) }),
    recoveryCodes: z.strictObject({ password: z.string().min(1).max(1024), proof: factorProofSchema }),
    mailbox: z.strictObject({ email: emailSchema }),
};
export const accountRoutes = {
    resetCheck: '/auth/password/reset/check',
    register: '/auth/register',
    registerV2: '/auth/register/v2',
    verify: '/auth/email/verify',
    resend: '/auth/email/resend',
    recovery: '/auth/password/recovery',
    reset: '/auth/password/reset',
    passwordChange: '/auth/password/change',
    emailChange: '/auth/email/change',
    emailConfirm: '/auth/email/change/confirm',
    emailCancel: '/auth/email/change/cancel',
    totpLogin: '/auth/totp/login',
    pinSetup: '/auth/pin/setup',
    pinLogin: '/auth/pin/login',
    pinRevoke: '/auth/pin/revoke',
    authenticatorSetup: '/auth/authenticator/setup',
    authenticatorConfirm: '/auth/authenticator/confirm',
    recoveryCodes: '/auth/authenticator/recovery-codes',
    mailbox: '/dev/mailbox',
} as const;
export const acceptedSchema = z.strictObject({ accepted: z.literal(true) });
export const securitySchema = z.strictObject({
    authenticatorEnabled: z.boolean(),
    pinEnabled: z.boolean(),
    pendingEmail: z
        .strictObject({ email: z.string(), effectiveAt: z.string().nullable(), confirmed: z.boolean() })
        .nullable(),
});
export const accountOutputs = {
    resetCheck: z.strictObject({ valid: z.literal(true) }),
    register: acceptedSchema,
    registerV2: acceptedSchema,
    verify: z.strictObject({ verified: z.literal(true) }),
    resend: acceptedSchema,
    recovery: acceptedSchema,
    reset: z.strictObject({ changed: z.literal(true) }),
    passwordChange: z.strictObject({ changed: z.literal(true) }),
    emailChange: acceptedSchema,
    emailConfirm: z.strictObject({ confirmed: z.literal(true), effectiveAt: z.string() }),
    emailCancel: z.strictObject({ cancelled: z.literal(true) }),
    pinSetup: z.strictObject({ enabled: z.literal(true) }),
    pinRevoke: z.strictObject({ revoked: z.literal(true) }),
    authenticatorSetup: z.strictObject({
        challenge: tokenSchema,
        expiresAt: z.string(),
        enrollment: z.strictObject({ secret: z.string(), uri: z.string() }),
    }),
    authenticatorConfirm: z.strictObject({ enabled: z.literal(true), recoveryCodes: z.array(z.string()) }),
    recoveryCodes: z.strictObject({ recoveryCodes: z.array(z.string()) }),
    mailbox: z.strictObject({
        messages: z.array(
            z.strictObject({
                id: z.string(),
                kind: z.enum(['verify', 'reset', 'email-confirm', 'email-cancel']),
                token: z.string(),
                createdAt: z.string(),
                expiresAt: z.string(),
            }),
        ),
    }),
};
