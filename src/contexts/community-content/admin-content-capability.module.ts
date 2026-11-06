import { Module } from '@nestjs/common';
import { AdminContentController, AdminContentService } from '../../modules/admin-content/public.js';
import { CatalogRecipesModule } from '../catalog-recipes/catalog-recipes.module.js';
import { ContentReleasesCapabilityModule } from './content-releases-capability.module.js';

@Module({
    imports: [CatalogRecipesModule, ContentReleasesCapabilityModule],
    controllers: [AdminContentController],
    providers: [AdminContentService],
    exports: [],
})
export class AdminContentCapabilityModule {}
