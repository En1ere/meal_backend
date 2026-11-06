import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import {
    AdminObservabilityController,
    AdminObservabilityRepository,
    AdminObservabilityService,
    HostSnapshotReader,
} from '../../modules/admin-observability/public.js';
import { AdminReadBoundaryCapabilityModule } from '../identity-access/admin-read-boundary-capability.module.js';

@Module({
    imports: [AdminReadBoundaryCapabilityModule],
    controllers: [AdminObservabilityController],
    providers: [
        AdminObservabilityRepository,
        AdminObservabilityService,
        {
            provide: HostSnapshotReader,
            inject: [APP_CONFIG],
            useFactory: (config: AppConfig) =>
                new HostSnapshotReader(
                    config.OBSERVABILITY_HOST_SNAPSHOT_ENABLED ? config.OBSERVABILITY_HOST_SNAPSHOT_FILE : undefined,
                ),
        },
    ],
    exports: [],
})
export class AdminObservabilityCapabilityModule {}
