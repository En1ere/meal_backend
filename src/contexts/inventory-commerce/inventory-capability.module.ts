import { Module } from '@nestjs/common';
import { InventoryController, InventoryService } from '../../modules/inventory/public.js';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';

@Module({
    imports: [EntitlementsCapabilityModule],
    controllers: [InventoryController],
    providers: [InventoryService],
})
export class InventoryCapabilityModule {}
