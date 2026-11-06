import { Module } from '@nestjs/common';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import { NutritionController, NutritionService } from '../../modules/nutrition/public.js';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';

@Module({
    imports: [ProAccessCapabilityModule, LegalConsentsCapabilityModule],
    controllers: [NutritionController],
    providers: [NutritionService],
    exports: [],
})
export class NutritionCapabilityModule {}
