import { Injectable } from '@nestjs/common';
import type { WorkerAlert, WorkerRunObservation, WorkerRuntimeSink } from '../operational-runtime/worker-runtime.js';
import type { ProviderObservation, ProviderTelemetry } from '../provider-runtime/provider-runtime.js';
import { TelemetryService } from './telemetry.service.js';

@Injectable()
export class AdminProviderTelemetry implements ProviderTelemetry {
    constructor(private readonly telemetry: TelemetryService) {}

    status() {
        return this.telemetry.status();
    }

    record(observation: ProviderObservation): Promise<void> {
        return this.telemetry.recordProvider(observation);
    }
}

@Injectable()
export class AdminWorkerRuntimeSink implements WorkerRuntimeSink {
    constructor(private readonly telemetry: TelemetryService) {}

    status() {
        return this.telemetry.status();
    }

    record(observation: WorkerRunObservation): Promise<void> {
        return this.telemetry.recordWorker(observation);
    }

    alert(alert: WorkerAlert): Promise<void> {
        return this.telemetry.recordWorkerAlert(alert);
    }
}

export class FanoutWorkerRuntimeSink implements WorkerRuntimeSink {
    constructor(private readonly sinks: readonly WorkerRuntimeSink[]) {}

    status() {
        return { configured: this.sinks.some((sink) => sink.status().configured), provider: 'fanout' } as const;
    }

    async record(observation: WorkerRunObservation): Promise<void> {
        await Promise.allSettled(this.sinks.map((sink) => sink.record(observation)));
    }

    async alert(alert: WorkerAlert): Promise<void> {
        await Promise.allSettled(this.sinks.map((sink) => sink.alert(alert)));
    }
}
