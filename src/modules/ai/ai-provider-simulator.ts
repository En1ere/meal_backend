import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
    AiProviderPort,
    FrozenProviderRequest,
    ProviderReadOutcome,
    ProviderSubmitOutcome,
} from './ai-provider-port.js';
import { frozenProviderRequestSchema } from './ai-provider-port.js';

export type AiProviderSimulatorScenario =
    | { kind: 'success'; result: unknown; queuedReads?: number }
    | { kind: 'rejected' }
    | { kind: 'unknown_without_identity' }
    | { kind: 'read_unknown' }
    | { kind: 'failed' };

type Accepted = {
    scenario: AiProviderSimulatorScenario;
    reads: number;
};

@Injectable()
export class AiProviderSimulator implements AiProviderPort {
    private readonly scenarios: AiProviderSimulatorScenario[] = [];
    private readonly accepted = new Map<string, Accepted>();

    enqueue(scenario: AiProviderSimulatorScenario) {
        this.scenarios.push(scenario);
    }

    reset() {
        this.scenarios.length = 0;
        this.accepted.clear();
    }

    async submit(request: FrozenProviderRequest): Promise<ProviderSubmitOutcome> {
        await Promise.resolve();
        const parsed = frozenProviderRequestSchema.safeParse(request);
        if (!parsed.success) return { kind: 'rejected', category: 'request_invalid', retryable: false };
        const scenario = this.scenarios.shift() ?? {
            kind: 'success',
            result: {
                schemaVersion: 'ai-result-contract-v2:culinary_question:answer',
                answer: 'Симулятор подготовил краткий кулинарный ответ.',
                warningCodes: [],
                recoveryCode: null,
            },
        };
        if (scenario.kind === 'rejected') return { kind: 'rejected', category: 'provider_disabled', retryable: false };
        if (scenario.kind === 'unknown_without_identity')
            return { kind: 'unknown_without_identity', clientRequestId: parsed.data.clientRequestId };
        const providerResponseId = `sim_${randomUUID().replaceAll('-', '')}`;
        this.accepted.set(providerResponseId, { scenario, reads: 0 });
        return { kind: 'accepted', providerResponseId, clientRequestId: parsed.data.clientRequestId };
    }

    async read(providerResponseId: string): Promise<ProviderReadOutcome> {
        await Promise.resolve();
        const accepted = this.accepted.get(providerResponseId);
        if (!accepted) return { kind: 'unknown' };
        accepted.reads += 1;
        if (accepted.scenario.kind === 'read_unknown') return { kind: 'unknown' };
        if (accepted.scenario.kind === 'failed') return { kind: 'failed', category: 'provider_failed' };
        if (accepted.scenario.kind !== 'success') return { kind: 'unknown' };
        if (accepted.reads <= (accepted.scenario.queuedReads ?? 0)) return { kind: 'queued' };
        return {
            kind: 'succeeded',
            rawResult: accepted.scenario.result,
            usage: { inputTokens: 32, outputTokens: 64, cachedInputTokens: 0, reasoningTokens: 0 },
        };
    }
}
