import { Module } from '@nestjs/common';
import { AiProvider } from '../../modules/ai/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [AiProvider],
    exports: [AiProvider],
})
export class AiProviderCapabilityModule {}
