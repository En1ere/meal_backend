import { Module } from '@nestjs/common';
import { AdminBillingController, AdminBillingService } from '../../modules/admin-billing/public.js';
import { PaymentApplicationCapabilityModule } from './payment-application-capability.module.js';

@Module({
    imports: [PaymentApplicationCapabilityModule],
    controllers: [AdminBillingController],
    providers: [AdminBillingService],
    exports: [],
})
export class AdminBillingCapabilityModule {}
