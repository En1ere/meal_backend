import { Module } from '@nestjs/common';
import { RecipeWorkspaceController, RecipeWorkspaceService } from '../../modules/recipe-workspace/public.js';
import { ContentReleasesCapabilityModule } from '../community-content/content-releases-capability.module.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { LegalConsentsCapabilityModule } from '../identity-access/legal-consents-capability.module.js';
import { CatalogRecipesModule } from './catalog-recipes.module.js';

@Module({
    imports: [
        CatalogRecipesModule,
        EntitlementsCapabilityModule,
        LegalConsentsCapabilityModule,
        ContentReleasesCapabilityModule,
    ],
    controllers: [RecipeWorkspaceController],
    providers: [RecipeWorkspaceService],
    exports: [],
})
export class RecipeWorkspaceCapabilityModule {}
