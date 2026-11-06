import { Module } from '@nestjs/common';
import { FinanceController, FinanceService } from '../../modules/finance/public.js';
import { ProAccessCapabilityModule } from '../household-entitlements/pro-access-capability.module.js';

@Module({
    imports: [ProAccessCapabilityModule],
    controllers: [FinanceController],
    providers: [FinanceService],
    exports: [],
})
export class FinanceCapabilityModule {}
