import { Module } from '@nestjs/common';
import { DisabledObjectStorageProvider, OBJECT_STORAGE_PROVIDER } from '../../modules/media-infrastructure/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledObjectStorageProvider,
        { provide: OBJECT_STORAGE_PROVIDER, useExisting: DisabledObjectStorageProvider },
    ],
    exports: [OBJECT_STORAGE_PROVIDER],
})
export class ObjectStorageProviderCapabilityModule {}
