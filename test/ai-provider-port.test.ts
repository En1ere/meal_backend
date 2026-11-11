import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    providerCommandFor,
    providerFinancialEffect,
    providerReadOutcomeSchema,
    providerSubmitOutcomeSchema,
} from '../src/modules/ai/public.js';

void test('provider-neutral outcomes are strict and bounded', () => {
    const clientRequestId = '018f2dd4-693f-7c4c-8b5d-c50d951f4f47';
    assert.equal(
        providerSubmitOutcomeSchema.safeParse({
            kind: 'accepted',
            providerResponseId: 'response-1',
            clientRequestId,
        }).success,
        true,
    );
    assert.equal(
        providerSubmitOutcomeSchema.safeParse({
            kind: 'unknown_without_identity',
            clientRequestId,
            providerResponseId: 'must-not-exist',
        }).success,
        false,
    );
    assert.equal(providerReadOutcomeSchema.safeParse({ kind: 'unknown', rawError: 'private' }).success, false);
});

void test('dispatch contract forbids submit after any provider outcome', () => {
    assert.equal(providerCommandFor({ kind: 'prepared' }), 'submit');
    assert.equal(providerCommandFor({ kind: 'accepted', providerResponseId: 'response-1' }), 'read');
    assert.equal(providerCommandFor({ kind: 'unknown_without_identity' }), 'none');
    assert.equal(providerCommandFor({ kind: 'rejected' }), 'none');
    assert.equal(providerCommandFor({ kind: 'terminal' }), 'none');
});

void test('user quota and provider budget effects are independent', () => {
    const clientRequestId = '018f2dd4-693f-7c4c-8b5d-c50d951f4f47';
    assert.deepEqual(providerFinancialEffect({ kind: 'unknown_without_identity', clientRequestId }), {
        userQuota: 'released',
        providerBudget: 'held',
    });
    assert.deepEqual(providerFinancialEffect({ kind: 'accepted', clientRequestId, providerResponseId: 'response-1' }), {
        userQuota: 'reserved',
        providerBudget: 'held',
    });
    assert.deepEqual(providerFinancialEffect({ kind: 'rejected', category: 'request_invalid', retryable: false }), {
        userQuota: 'released',
        providerBudget: 'released',
    });
});
