import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    DisabledProviderTelemetry,
    DisabledSecretProvider,
    ProviderCallFailure,
    ProviderObserver,
    SecretMaterial,
    providerObservationSchema,
    secretReferenceSchema,
    type ProviderObservation,
    type ProviderTelemetry,
} from '../src/modules/provider-runtime/provider-runtime.js';

const reference = {
    backend: 'vault_candidate',
    name: 'meal-planner/providers/ai-token',
    version: 'rotation-2026-10',
    service: 'ai',
} as const;
const context = { service: 'ai', provider: 'openai', operation: 'responses.create', attempt: 1 } as const;
const clock = {
    now: () => new Date('2026-10-09T10:00:00.000Z'),
    monotonicNow: (() => {
        const values = [100, 112];
        return () => values.shift() ?? 112;
    })(),
};

class CapturingTelemetry implements ProviderTelemetry {
    readonly observations: ProviderObservation[] = [];
    status() {
        return { configured: true, provider: 'capture' } as const;
    }
    record(observation: ProviderObservation): Promise<void> {
        this.observations.push(observation);
        return Promise.resolve();
    }
}

void test('secret references are versioned opaque identifiers and never inline credentials', () => {
    assert.equal(secretReferenceSchema.safeParse(reference).success, true);
    assert.equal(secretReferenceSchema.safeParse({ ...reference, name: '../token' }).success, false);
    assert.equal(secretReferenceSchema.safeParse({ ...reference, name: 'https://vault.example/token' }).success, false);
    assert.equal(secretReferenceSchema.safeParse({ ...reference, value: 'must-not-cross-boundary' }).success, false);
});

void test('secret material redacts serialization and becomes unusable after destruction', () => {
    const value = 'provider-secret-value';
    const material = SecretMaterial.from(value);
    assert.equal(
        material.use((secret) => secret.length),
        value.length,
    );
    assert.equal(String(material), '[REDACTED]');
    assert.equal(JSON.stringify(material), '"[REDACTED]"');
    assert.equal(inspect(material).includes(value), false);
    material.destroy();
    assert.throws(() => material.use((secret) => secret), /destroyed/);
});

void test('unselected secret provider fails closed without exposing the reference', async () => {
    const provider = new DisabledSecretProvider();
    assert.deepEqual(provider.status(), { configured: false, provider: null });
    await assert.rejects(provider.resolve(reference), (error: unknown) => {
        return error instanceof ServiceUnavailableException && !error.message.includes(reference.name);
    });
});

void test('provider observations are strict, bounded and reject high-cardinality payloads', () => {
    const observation = {
        ...context,
        outcome: 'success',
        errorKind: null,
        durationMs: 12,
        occurredAt: '2026-10-09T10:00:00.000Z',
    } as const;
    assert.equal(providerObservationSchema.safeParse(observation).success, true);
    for (const injected of [
        { payload: { prompt: 'private' } },
        { errorMessage: 'provider token leaked' },
        { userId: crypto.randomUUID() },
        { requestUrl: 'https://provider.example/private' },
    ]) {
        assert.equal(providerObservationSchema.safeParse({ ...observation, ...injected }).success, false);
    }
});

void test('observer records a low-cardinality success without changing its result', async () => {
    const telemetry = new CapturingTelemetry();
    const observer = new ProviderObserver(telemetry);
    assert.equal(await observer.observe(context, () => Promise.resolve('result'), clock), 'result');
    assert.deepEqual(telemetry.observations, [
        {
            ...context,
            outcome: 'success',
            errorKind: null,
            durationMs: 12,
            occurredAt: '2026-10-09T10:00:00.000Z',
        },
    ]);
});

void test('observer keeps the original failure and records only its safe classification', async () => {
    const telemetry = new CapturingTelemetry();
    const observer = new ProviderObserver(telemetry);
    const failure = new ProviderCallFailure('timeout', 'network');
    await assert.rejects(
        observer.observe(context, () => Promise.reject(failure), clock),
        (error: unknown) => error === failure,
    );
    assert.equal(telemetry.observations[0]?.outcome, 'timeout');
    assert.equal(telemetry.observations[0]?.errorKind, 'network');
    assert.equal(JSON.stringify(telemetry.observations).includes('Provider call failed'), false);
});

void test('disabled or failing telemetry never masks provider success', async () => {
    const disabled = new DisabledProviderTelemetry();
    assert.deepEqual(disabled.status(), { configured: false, provider: null });
    assert.equal(await new ProviderObserver(disabled).observe(context, () => Promise.resolve(42), clock), 42);
    const failing: ProviderTelemetry = {
        status: () => ({ configured: true, provider: 'broken' }),
        record: () => Promise.reject(new Error('telemetry unavailable')),
    };
    assert.equal(await new ProviderObserver(failing).observe(context, () => Promise.resolve(43), clock), 43);
});
