import { Module } from '@nestjs/common';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import {
    AchievementsController,
    ContentReleasesController,
    ContentReleasesService,
} from '../../modules/content-releases/public.js';

@Module({
    imports: [LegalConsentsCapabilityModule],
    controllers: [ContentReleasesController, AchievementsController],
    providers: [ContentReleasesService],
    exports: [ContentReleasesService],
})
export class ContentReleasesCapabilityModule {}
