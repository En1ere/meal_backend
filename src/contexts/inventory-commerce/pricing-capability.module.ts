import { Module } from '@nestjs/common';
import { PricingController, PricingService } from '../../modules/finance/public.js';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';

@Module({
    imports: [ProAccessCapabilityModule],
    controllers: [PricingController],
    providers: [PricingService],
    exports: [],
})
export class PricingCapabilityModule {}
