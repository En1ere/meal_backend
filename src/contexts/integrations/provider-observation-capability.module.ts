import { Module } from '@nestjs/common';
import { ProviderObserver } from '../../modules/provider-runtime/public.js';
import { TelemetryCapabilityModule } from '../platform-operations/telemetry-capability.module.js';

@Module({
    imports: [TelemetryCapabilityModule],
    controllers: [],
    providers: [ProviderObserver],
    exports: [],
})
export class ProviderObservationCapabilityModule {}
