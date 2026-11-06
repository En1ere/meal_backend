import { Module } from '@nestjs/common';
import { ContentReleasesCapabilityModule } from '../community-content/content-releases-capability.module.js';
import { OperationalRuntimeCapabilityModule } from '../platform-operations/operational-runtime-capability.module.js';
import {
    CookingController,
    CookingLifecycleService,
    CookingService,
    CookingStatisticsController,
    CookingStatisticsPolicy,
} from '../../modules/cooking/public.js';
import { RecipesCapabilityModule } from './recipes-capability.module.js';

@Module({
    imports: [RecipesCapabilityModule, OperationalRuntimeCapabilityModule, ContentReleasesCapabilityModule],
    controllers: [CookingController, CookingStatisticsController],
    providers: [CookingService, CookingLifecycleService, CookingStatisticsPolicy],
    exports: [],
})
export class CookingCapabilityModule {}
