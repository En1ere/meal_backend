import { Module } from '@nestjs/common';
import {
    AdminNewsController,
    AdminNewsService,
    NewsPublicController,
    NewsPublicService,
    ScheduledNewsRunner,
} from '../../modules/admin-news/public.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule, LegalConsentsCapabilityModule],
    controllers: [AdminNewsController, NewsPublicController],
    providers: [AdminNewsService, ScheduledNewsRunner, NewsPublicService],
    exports: [],
})
export class AdminNewsCapabilityModule {}
