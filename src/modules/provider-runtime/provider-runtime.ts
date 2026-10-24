import { inspect } from 'node:util';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');
export const PROVIDER_TELEMETRY = Symbol('PROVIDER_TELEMETRY');

export const providerServiceSchema = z.enum([
    'ai',
    'payment',
    'object_storage',
    'key_management',
    'malware_scanner',
    'email',
    'web_push',
    'ocr',
]);
export type ProviderService = z.infer<typeof providerServiceSchema>;

const boundedCodeSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const secretNameSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_-]*$/)
    .refine((value) => !value.includes('..') && !value.includes('//'), 'Expected an opaque secret name');

export const secretReferenceSchema = z.strictObject({
    backend: boundedCodeSchema,
    name: secretNameSchema,
    version: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    service: providerServiceSchema,
});
export type SecretReference = z.infer<typeof secretReferenceSchema>;

export const secretMetadataSchema = z.strictObject({
    backend: boundedCodeSchema,
    version: z.string().min(1).max(100),
    fetchedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
});
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;

export class SecretMaterial {
    readonly #bytes: Buffer;
    #destroyed = false;

    private constructor(bytes: Buffer) {
        this.#bytes = bytes;
    }

    static from(value: string): SecretMaterial {
        const bytes = Buffer.from(value, 'utf8');
        if (bytes.length < 1 || bytes.length > 16_384 || bytes.includes(0)) {
            bytes.fill(0);
            throw new Error('Invalid secret material');
        }
        return new SecretMaterial(bytes);
    }

    use<T>(consumer: (value: string) => T): T {
        if (this.#destroyed) throw new Error('Secret material has been destroyed');
        return consumer(this.#bytes.toString('utf8'));
    }

    destroy(): void {
        this.#bytes.fill(0);
        this.#destroyed = true;
    }

    toString(): string {
        return '[REDACTED]';
    }

    toJSON(): string {
        return '[REDACTED]';
    }

    [inspect.custom](): string {
        return 'SecretMaterial([REDACTED])';
    }
}

export type ResolvedSecret = Readonly<{ material: SecretMaterial; metadata: SecretMetadata }>;

export interface SecretProvider {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    resolve(reference: SecretReference): Promise<ResolvedSecret>;
}

export const providerObservationSchema = z.strictObject({
    service: providerServiceSchema,
    provider: boundedCodeSchema,
    operation: boundedCodeSchema,
    outcome: z.enum(['success', 'provider_error', 'timeout', 'cancelled', 'boundary_rejected', 'unavailable']),
    errorKind: z
        .enum(['authentication', 'rate_limit', 'validation', 'network', 'provider_internal', 'unknown'])
        .nullable(),
    durationMs: z.number().int().min(0).max(86_400_000),
    attempt: z.number().int().min(1).max(10),
    occurredAt: z.iso.datetime(),
});
export type ProviderObservation = z.infer<typeof providerObservationSchema>;

export type ProviderCallContext = Readonly<{
    service: ProviderService;
    provider: string;
    operation: string;
    attempt: number;
}>;

export interface ProviderTelemetry {
    status(): Readonly<{ configured: boolean; provider: string | null }>;
    record(observation: ProviderObservation): Promise<void>;
}

export class ProviderCallFailure extends Error {
    constructor(
        public readonly outcome: Exclude<ProviderObservation['outcome'], 'success'>,
        public readonly errorKind: Exclude<ProviderObservation['errorKind'], null>,
    ) {
        super('Provider call failed');
    }
}

@Injectable()
export class DisabledSecretProvider implements SecretProvider {
    status() {
        return { configured: false, provider: null } as const;
    }

    resolve(reference: SecretReference): Promise<ResolvedSecret> {
        void reference;
        return Promise.reject(new ServiceUnavailableException('Secret provider is not configured'));
    }
}

@Injectable()
export class DisabledProviderTelemetry implements ProviderTelemetry {
    status() {
        return { configured: false, provider: null } as const;
    }

    record(observation: ProviderObservation): Promise<void> {
        void observation;
        return Promise.resolve();
    }
}

@Injectable()
export class ProviderObserver {
    constructor(@Inject(PROVIDER_TELEMETRY) private readonly telemetry: ProviderTelemetry) {}

    async observe<T>(
        contextValue: ProviderCallContext,
        execute: () => Promise<T>,
        options: Readonly<{ now?: () => Date; monotonicNow?: () => number }> = {},
    ): Promise<T> {
        const context = z
            .strictObject({
                service: providerServiceSchema,
                provider: boundedCodeSchema,
                operation: boundedCodeSchema,
                attempt: z.number().int().min(1).max(10),
            })
            .parse(contextValue);
        const now = options.now ?? (() => new Date());
        const monotonicNow = options.monotonicNow ?? (() => performance.now());
        const started = monotonicNow();
        try {
            const result = await execute();
            await this.record({
                ...context,
                outcome: 'success',
                errorKind: null,
                durationMs: this.duration(started, monotonicNow()),
                occurredAt: now().toISOString(),
            });
            return result;
        } catch (error) {
            const failure =
                error instanceof ProviderCallFailure ? error : new ProviderCallFailure('provider_error', 'unknown');
            await this.record({
                ...context,
                outcome: failure.outcome,
                errorKind: failure.errorKind,
                durationMs: this.duration(started, monotonicNow()),
                occurredAt: now().toISOString(),
            });
            throw error;
        }
    }

    private duration(started: number, finished: number): number {
        if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
        return Math.min(86_400_000, Math.max(0, Math.round(finished - started)));
    }

    private async record(value: ProviderObservation): Promise<void> {
        try {
            const observation = providerObservationSchema.parse(value);
            await this.telemetry.record(observation);
        } catch {
            // Telemetry must never change the provider call outcome.
        }
    }
}
