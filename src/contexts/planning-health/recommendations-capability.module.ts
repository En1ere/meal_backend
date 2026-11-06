import { Module } from '@nestjs/common';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { RecommendationsController, RecommendationsService } from '../../modules/recommendations/public.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [RecommendationsController],
    providers: [RecommendationsService],
    exports: [RecommendationsService],
})
export class RecommendationsCapabilityModule {}
