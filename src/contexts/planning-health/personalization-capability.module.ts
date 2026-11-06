import { Module } from '@nestjs/common';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import { PersonalizationController, PersonalizationService } from '../../modules/personalization/public.js';
import { RecommendationsCapabilityModule } from './recommendations-capability.module.js';

@Module({
    imports: [RecommendationsCapabilityModule, LegalConsentsCapabilityModule],
    controllers: [PersonalizationController],
    providers: [PersonalizationService],
    exports: [],
})
export class PersonalizationCapabilityModule {}
