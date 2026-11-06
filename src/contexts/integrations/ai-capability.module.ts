import { Module } from '@nestjs/common';
import { AiController, AiReconciliationService, AiService } from '../../modules/ai/public.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import { OperationalRuntimeCapabilityModule } from '../platform-operations/operational-runtime-capability.module.js';
import { AiProviderCapabilityModule } from './ai-provider-capability.module.js';

@Module({
    imports: [
        AiProviderCapabilityModule,
        EntitlementsCapabilityModule,
        LegalConsentsCapabilityModule,
        OperationalRuntimeCapabilityModule,
    ],
    controllers: [AiController],
    providers: [AiService, AiReconciliationService],
    exports: [AiService],
})
export class AiCapabilityModule {}
