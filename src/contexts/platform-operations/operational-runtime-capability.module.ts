import { Module } from '@nestjs/common';
import { WorkerRuntimeFactory } from '../../infrastructure/workers/worker-runtime.factory.js';
import { TelemetryCapabilityModule } from './telemetry-capability.module.js';

@Module({
    imports: [TelemetryCapabilityModule],
    providers: [WorkerRuntimeFactory],
    exports: [WorkerRuntimeFactory],
})
export class OperationalRuntimeCapabilityModule {}
