import { Module } from '@nestjs/common';
import {
    AiMealPlanBackendService,
    AiShoppingRecipesBackendService,
    AiV2Controller,
    AiV2OrchestratorService,
} from '../../modules/ai-meal-plan/public.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { MealPlanCapabilityModule } from '../planning-health/meal-plan-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule, MealPlanCapabilityModule],
    controllers: [AiV2Controller],
    providers: [AiMealPlanBackendService, AiShoppingRecipesBackendService, AiV2OrchestratorService],
    exports: [AiV2OrchestratorService],
})
export class AiMealPlanCapabilityModule {}
