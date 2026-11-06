import { Module } from '@nestjs/common';
import { EntitlementsCapabilityModule } from '../household-entitlements/entitlements-capability.module.js';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';
import {
    PurchasesController,
    PurchasesService,
    ReceiptsController,
    ReceiptsService,
} from '../../modules/receipts/public.js';

@Module({
    imports: [EntitlementsCapabilityModule, ProAccessCapabilityModule],
    controllers: [ReceiptsController, PurchasesController],
    providers: [ReceiptsService, PurchasesService],
    exports: [],
})
export class ReceiptsCapabilityModule {}
