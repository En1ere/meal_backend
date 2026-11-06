import { Module } from '@nestjs/common';
import { RecipeLifecycleService } from '../../modules/recipe-lifecycle/public.js';
import { RecipePolicyController, RecipePolicyService } from '../../modules/recipe-policy/public.js';

@Module({
    controllers: [RecipePolicyController],
    providers: [RecipePolicyService, RecipeLifecycleService],
    exports: [RecipePolicyService, RecipeLifecycleService],
})
export class CatalogRecipesModule {}
