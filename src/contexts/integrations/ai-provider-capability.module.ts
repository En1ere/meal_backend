import { Module } from '@nestjs/common';
import {
    AI_V2_PROVIDER_PORT,
    AI_V2_PROVIDER_RUNTIME,
    AiProvider,
    AiProviderSimulator,
} from '../../modules/ai/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [
        AiProvider,
        AiProviderSimulator,
        { provide: AI_V2_PROVIDER_PORT, useExisting: AiProviderSimulator },
        {
            provide: AI_V2_PROVIDER_RUNTIME,
            useValue: {
                kind: 'simulator',
                readiness: 'ready',
                profileVersions: ['yandex-alice-flash-economy-v1'],
            },
        },
    ],
    exports: [AiProvider, AI_V2_PROVIDER_PORT, AI_V2_PROVIDER_RUNTIME],
})
export class AiProviderCapabilityModule {}
