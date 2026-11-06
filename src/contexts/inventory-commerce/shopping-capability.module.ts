import { Module } from '@nestjs/common';
import { RecipesCapabilityModule } from '../catalog-recipes/recipes-capability.module.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { ShoppingController, ShoppingService } from '../../modules/shopping/public.js';

@Module({
    imports: [RecipesCapabilityModule, EntitlementsCapabilityModule],
    controllers: [ShoppingController],
    providers: [ShoppingService],
    exports: [],
})
export class ShoppingCapabilityModule {}
