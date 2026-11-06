import { Module } from '@nestjs/common';
import { DisabledKeyManagementProvider, KEY_MANAGEMENT_PROVIDER } from '../../modules/media-infrastructure/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        DisabledKeyManagementProvider,
        { provide: KEY_MANAGEMENT_PROVIDER, useExisting: DisabledKeyManagementProvider },
    ],
    exports: [KEY_MANAGEMENT_PROVIDER],
})
export class KeyManagementProviderCapabilityModule {}
