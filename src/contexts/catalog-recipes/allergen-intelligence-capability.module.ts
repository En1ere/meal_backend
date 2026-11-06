import { Module } from '@nestjs/common';
import {
    AdminAllergensController,
    AllergenIntelligenceService,
    AllergenReportController,
} from '../../modules/allergen-intelligence/public.js';

@Module({
    controllers: [AdminAllergensController, AllergenReportController],
    providers: [AllergenIntelligenceService],
    exports: [AllergenIntelligenceService],
})
export class AllergenIntelligenceCapabilityModule {}
