import { Module } from '@nestjs/common';
import { MediaStorageController, MediaStorageService } from '../../modules/media-storage/public.js';
import { MediaObjectStoreCapabilityModule } from './media-object-store-capability.module.js';

@Module({
    imports: [MediaObjectStoreCapabilityModule],
    controllers: [MediaStorageController],
    providers: [MediaStorageService],
    exports: [],
})
export class MediaStorageCapabilityModule {}
