import { Module } from '@nestjs/common';
import {
    AiController,
    AiReconciliationService,
    AiService,
    AiV2BeveragePairingExecutor,
    AiV2BeveragePairingInternalService,
    AiV2CulinaryExecutor,
    AiV2CulinaryInternalService,
    AiV2IngredientExtractionExecutor,
    AiV2IngredientExtractionInternalService,
    AiV2PersonalRecommendationInternalService,
    AiV2PublicActivationGate,
    AiV2ProductClassificationExecutor,
    AiV2ProductClassificationInternalService,
    AiV2RecipeFromStockExecutor,
    AiV2RecipeFromStockInternalService,
    AiV2RecipeAdaptationExecutor,
    AiV2RecipeAdaptationInternalService,
    AiV2ProviderOperationStore,
    AiV2StorageAdviceExecutor,
    AiV2StorageAdviceInternalService,
    AiV2SubstitutionExecutor,
    AiV2SubstitutionInternalService,
} from '../../modules/ai/public.js';
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
    providers: [
        AiService,
        AiReconciliationService,
        AiV2BeveragePairingExecutor,
        AiV2BeveragePairingInternalService,
        AiV2ProviderOperationStore,
        AiV2CulinaryExecutor,
        AiV2CulinaryInternalService,
        AiV2IngredientExtractionExecutor,
        AiV2IngredientExtractionInternalService,
        AiV2PersonalRecommendationInternalService,
        AiV2ProductClassificationExecutor,
        AiV2ProductClassificationInternalService,
        AiV2RecipeFromStockExecutor,
        AiV2RecipeFromStockInternalService,
        AiV2RecipeAdaptationExecutor,
        AiV2RecipeAdaptationInternalService,
        AiV2SubstitutionExecutor,
        AiV2SubstitutionInternalService,
        AiV2StorageAdviceExecutor,
        AiV2StorageAdviceInternalService,
        AiV2PublicActivationGate,
    ],
    exports: [AiService],
})
export class AiCapabilityModule {}
