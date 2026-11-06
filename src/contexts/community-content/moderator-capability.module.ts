import { Module } from '@nestjs/common';
import { ModeratorController, ModeratorService, ModeratorSessionGuard } from '../../modules/moderator/public.js';
import { CatalogRecipesModule } from '../catalog-recipes/catalog-recipes.module.js';
import { ContentReleasesCapabilityModule } from './content-releases-capability.module.js';

@Module({
    imports: [CatalogRecipesModule, ContentReleasesCapabilityModule],
    controllers: [ModeratorController],
    providers: [ModeratorService, ModeratorSessionGuard],
    exports: [],
})
export class ModeratorCapabilityModule {}
