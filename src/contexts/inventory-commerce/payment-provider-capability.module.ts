import { Module } from '@nestjs/common';
import { DisabledPaymentProvider, PAYMENT_PROVIDER } from '../../modules/payments/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [DisabledPaymentProvider, { provide: PAYMENT_PROVIDER, useExisting: DisabledPaymentProvider }],
    exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderCapabilityModule {}
