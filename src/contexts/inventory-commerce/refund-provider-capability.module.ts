import { Module } from '@nestjs/common';
import { DisabledRefundProvider, REFUND_PROVIDER } from '../../modules/payments/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [DisabledRefundProvider, { provide: REFUND_PROVIDER, useExisting: DisabledRefundProvider }],
    exports: [REFUND_PROVIDER],
})
export class RefundProviderCapabilityModule {}
