import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
    PAYMENT_PROVIDER,
    paymentStartRequestSchema,
    validatePaymentSnapshot,
    type PaymentProvider,
    type PaymentSnapshot,
    type PaymentStartRequest,
    type PaymentState,
    type PaymentWebhookRequest,
    type VerifiedPaymentEvent,
} from './payment-provider.js';
import {
    REFUND_PROVIDER,
    type ProviderOutcome,
    type RefundProvider,
    type RefundRequest,
    type RefundTransition,
} from './refunds.js';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

export type CheckoutCommand = Readonly<PaymentStartRequest & { payerId: string }>;
export type ReservedCheckout = Readonly<{
    attemptId: string;
    request: PaymentStartRequest;
    state: PaymentState;
    snapshot: PaymentSnapshot | null;
    replayed: boolean;
}>;
export type ReconciliationCommand = Readonly<{
    attemptId: string;
    requestedBy: string | null;
    reason: string;
}>;
export type ReservedRefund = Readonly<{
    refundId: string;
    request: RefundRequest;
    status: ProviderOutcome;
    replayed: boolean;
}>;

export interface PaymentRepository {
    reserveCheckout(command: CheckoutCommand, provider: string, requestHash: string): Promise<ReservedCheckout>;
    markCheckoutUnknown(attemptId: string): Promise<void>;
    applyPaymentSnapshot(
        attemptId: string,
        snapshot: PaymentSnapshot,
        source: 'checkout' | 'reconciliation',
    ): Promise<PaymentSnapshot>;
    applyVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentSnapshot>;
    paymentLookup(
        attemptId: string,
    ): Promise<Readonly<{ request: { provider: string; externalId: string; orderId: string } }>>;
    recordReconciliation(command: ReconciliationCommand, snapshot: PaymentSnapshot): Promise<PaymentSnapshot>;
    reserveRefund(requestedBy: string, request: RefundRequest, requestHash: string): Promise<ReservedRefund>;
    settleRefund(refundId: string, outcome: ProviderOutcome, providerEventId?: string): Promise<RefundTransition>;
}

const fingerprint = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const unavailable = () =>
    new ServiceUnavailableException({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'Платёжный провайдер не подключён.',
    });
const reconciliationRequired = () =>
    new ConflictException({
        code: 'PAYMENT_RECONCILIATION_REQUIRED',
        message: 'Исход операции ещё не подтверждён. Требуется сверка с платёжным провайдером.',
    });

@Injectable()
export class PaymentApplicationService {
    constructor(
        @Inject(PAYMENT_REPOSITORY) private readonly repository: PaymentRepository,
        @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
        @Inject(REFUND_PROVIDER) private readonly refunds: RefundProvider,
    ) {}

    async checkout(command: CheckoutCommand): Promise<PaymentSnapshot> {
        const providerStatus = this.payments.status();
        if (!providerStatus.configured || !providerStatus.provider) throw unavailable();
        const { payerId: ignored, ...rawRequest } = command;
        void ignored;
        const request = paymentStartRequestSchema.parse(rawRequest);
        const reserved = await this.repository.reserveCheckout(command, providerStatus.provider, fingerprint(command));
        if (reserved.snapshot) return reserved.snapshot;
        if (reserved.replayed) throw reconciliationRequired();
        try {
            const snapshot = validatePaymentSnapshot(request, await this.payments.createPayment(request));
            return await this.repository.applyPaymentSnapshot(reserved.attemptId, snapshot, 'checkout');
        } catch (error) {
            await this.repository.markCheckoutUnknown(reserved.attemptId);
            throw error;
        }
    }

    async webhook(request: PaymentWebhookRequest): Promise<PaymentSnapshot> {
        if (!this.payments.status().configured) throw unavailable();
        return this.repository.applyVerifiedEvent(await this.payments.verifyWebhook(request));
    }

    async reconcile(command: ReconciliationCommand): Promise<PaymentSnapshot> {
        if (!this.payments.status().configured) throw unavailable();
        const binding = await this.repository.paymentLookup(command.attemptId);
        const snapshot = await this.payments.lookupPayment(binding.request);
        return this.repository.recordReconciliation(command, snapshot);
    }

    async refund(requestedBy: string, request: RefundRequest): Promise<RefundTransition> {
        if (!this.refunds.status().configured) throw unavailable();
        const reserved = await this.repository.reserveRefund(requestedBy, request, fingerprint(request));
        if (reserved.status === 'succeeded' || reserved.status === 'failed')
            return this.repository.settleRefund(reserved.refundId, reserved.status);
        if (reserved.replayed) throw reconciliationRequired();
        try {
            const outcome = await this.refunds.refund(request);
            return await this.repository.settleRefund(reserved.refundId, outcome);
        } catch (error) {
            await this.repository.settleRefund(reserved.refundId, 'unknown');
            throw error;
        }
    }

    async reconcileRefund(refundId: string, request: RefundRequest): Promise<RefundTransition> {
        if (!this.refunds.status().configured) throw unavailable();
        return this.repository.settleRefund(refundId, await this.refunds.lookup(request.paymentId, request.key));
    }
}
