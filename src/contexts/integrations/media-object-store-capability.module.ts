import { Module } from '@nestjs/common';
import {
    DisabledMediaObjectStore,
    MEDIA_OBJECT_STORE,
    S3MediaObjectStore,
} from '../../modules/media-storage/public.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledMediaObjectStore,
        {
            provide: S3MediaObjectStore,
            inject: [APP_CONFIG],
            useFactory: (config: AppConfig) => new S3MediaObjectStore(config),
        },
        {
            provide: MEDIA_OBJECT_STORE,
            inject: [APP_CONFIG, DisabledMediaObjectStore, S3MediaObjectStore],
            useFactory: (config: AppConfig, disabled: DisabledMediaObjectStore, s3: S3MediaObjectStore) =>
                config.MEDIA_STORAGE_ENABLED ? s3 : disabled,
        },
    ],
    exports: [MEDIA_OBJECT_STORE],
})
export class MediaObjectStoreCapabilityModule {}
