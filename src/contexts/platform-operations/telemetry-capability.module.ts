import { Module } from '@nestjs/common';
import { PROVIDER_TELEMETRY } from '../../modules/provider-runtime/public.js';
import {
    AdminProviderTelemetry,
    AdminWorkerRuntimeSink,
    TelemetryController,
    TelemetryRepository,
    TelemetryService,
} from '../../modules/telemetry/public.js';

@Module({
    controllers: [TelemetryController],
    providers: [
        TelemetryRepository,
        TelemetryService,
        AdminProviderTelemetry,
        AdminWorkerRuntimeSink,
        { provide: PROVIDER_TELEMETRY, useExisting: AdminProviderTelemetry },
    ],
    exports: [TelemetryService, AdminWorkerRuntimeSink, PROVIDER_TELEMETRY],
})
export class TelemetryCapabilityModule {}
