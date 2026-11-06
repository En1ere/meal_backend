import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import {
    AdminRuntimeSettingsController,
    AdminRuntimeSettingsService,
    LocalBackupStatusReader,
} from '../../modules/admin-runtime-settings/public.js';

@Module({
    imports: [],
    controllers: [AdminRuntimeSettingsController],
    providers: [
        AdminRuntimeSettingsService,
        {
            provide: LocalBackupStatusReader,
            inject: [APP_CONFIG],
            useFactory: (config: AppConfig) =>
                new LocalBackupStatusReader(
                    config.OBSERVABILITY_HOST_SNAPSHOT_ENABLED
                        ? '/run/meal-observability/local-backup.json'
                        : undefined,
                ),
        },
    ],
    exports: [],
})
export class AdminRuntimeSettingsCapabilityModule {}
