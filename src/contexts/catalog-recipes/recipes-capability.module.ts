import { Module } from '@nestjs/common';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { RecommendationsCapabilityModule } from '../planning-health/recommendations-capability.module.js';
import { AllergenIntelligenceCapabilityModule } from './allergen-intelligence-capability.module.js';
import { RecipesController, RecipesService } from '../../modules/recipes/public.js';

@Module({
    imports: [EntitlementsCapabilityModule, RecommendationsCapabilityModule, AllergenIntelligenceCapabilityModule],
    controllers: [RecipesController],
    providers: [RecipesService],
    exports: [RecipesService],
})
export class RecipesCapabilityModule {}
