import { Module } from '@nestjs/common';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { MealPlanController, MealPlanService, PortionsController } from '../../modules/meal-plan/public.js';
import { DiaryCapabilityModule } from './diary-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule, DiaryCapabilityModule],
    controllers: [MealPlanController, PortionsController],
    providers: [MealPlanService],
    exports: [MealPlanService],
})
export class MealPlanCapabilityModule {}
