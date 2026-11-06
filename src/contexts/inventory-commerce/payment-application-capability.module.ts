import { Module } from '@nestjs/common';
import { PaymentApplicationService } from '../../modules/payments/public.js';
import { PaymentProviderCapabilityModule } from './payment-provider-capability.module.js';
import { PaymentRepositoryCapabilityModule } from './payment-repository-capability.module.js';
import { RefundProviderCapabilityModule } from './refund-provider-capability.module.js';

@Module({
    imports: [PaymentProviderCapabilityModule, RefundProviderCapabilityModule, PaymentRepositoryCapabilityModule],
    controllers: [],
    providers: [PaymentApplicationService],
    exports: [PaymentApplicationService],
})
export class PaymentApplicationCapabilityModule {}
