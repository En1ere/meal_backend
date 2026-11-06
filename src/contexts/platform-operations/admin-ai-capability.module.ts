import { Module } from '@nestjs/common';
import { AdminAiController, AdminAiService } from '../../modules/admin-ai/public.js';
import { AdminReadBoundaryCapabilityModule } from '../identity-access/admin-read-boundary-capability.module.js';
import { AiProviderCapabilityModule } from '../integrations/ai-provider-capability.module.js';

@Module({
    imports: [AdminReadBoundaryCapabilityModule, AiProviderCapabilityModule],
    controllers: [AdminAiController],
    providers: [AdminAiService],
    exports: [],
})
export class AdminAiCapabilityModule {}
