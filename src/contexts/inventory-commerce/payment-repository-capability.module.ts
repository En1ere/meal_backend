import { Module } from '@nestjs/common';
import { PAYMENT_REPOSITORY, PostgresPaymentRepository } from '../../modules/payments/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [PostgresPaymentRepository, { provide: PAYMENT_REPOSITORY, useExisting: PostgresPaymentRepository }],
    exports: [PAYMENT_REPOSITORY],
})
export class PaymentRepositoryCapabilityModule {}
