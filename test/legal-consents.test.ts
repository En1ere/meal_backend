import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';
import {
    immutableLegalDocumentRefSchema,
    publicLegalManifestSchema,
    registrationLegalEvidenceSchema,
} from '../src/modules/legal-consents/legal-consent.contracts.js';
import {
    DatabaseLegalDocumentProvider,
    demonstrationDocument,
    demonstrationManifest,
} from '../src/modules/legal-consents/legal-document.provider.js';
import type { DatabaseService } from '../src/infrastructure/database/database.service.js';
import type { LegalDocumentProvider } from '../src/modules/legal-consents/legal-document.provider.js';
import { marketingDeliveryAllowed } from '../src/modules/admin-news/news-delivery.js';
import { allergenPreferencesChanged } from '../src/modules/personalization/personalization.service.js';
import {
    consentEvidenceEnables,
    LegalConsentService,
    LegalConsentRequiredException,
} from '../src/modules/legal-consents/legal-consent.service.js';

const productionDemonstrationConfig = () =>
    readConfig({
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://meal.example.test',
        ADMIN_FRONTEND_ORIGIN: 'https://admin.meal.example.test',
        DATABASE_URL: 'postgresql://meal:password@database/meal_planner_postgres',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        LEGAL_EVIDENCE_MODE: 'demonstration',
    });

await test('legal manifest is demonstration-only when explicitly enabled, including production', async () => {
    const app = await createApp(
        readConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            SECURITY_KEY: randomBytes(32).toString('base64'),
            MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
            LEGAL_EVIDENCE_MODE: 'demonstration',
        }),
    );
    try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/legal/manifest' });
        assert.equal(response.statusCode, 200);
        const manifest = publicLegalManifestSchema.parse(response.json<{ data: unknown }>().data);
        assert.equal(manifest.status, 'demonstration');
        assert.equal(manifest.documents.length, 6);
        assert.ok(manifest.documents.every((document) => document.publicUrl === null));
    } finally {
        await app.close();
    }
    const productionProvider = new DatabaseLegalDocumentProvider(
        {} as DatabaseService,
        productionDemonstrationConfig(),
    );
    assert.equal((await productionProvider.manifest()).status, 'demonstration');
});

await test('approved is the default and never falls back to demonstration without a ready database', async () => {
    const app = await createApp(
        readConfig({
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            SECURITY_KEY: randomBytes(32).toString('base64'),
            MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        }),
    );
    try {
        const response = await app.inject({ method: 'GET', url: '/api/v1/legal/manifest' });
        assert.equal(response.statusCode, 503);
    } finally {
        await app.close();
    }
});

await test('explicit demonstration validates exact registration evidence and rejects stale or mixed refs', async () => {
    const manifest = demonstrationManifest();
    const service = new LegalConsentService(
        {} as DatabaseService,
        { manifest: () => Promise.resolve(manifest) } satisfies LegalDocumentProvider,
        productionDemonstrationConfig(),
    );
    const offer = manifest.documents.find((item) => item.kind === 'offer')!;
    const privacy = manifest.documents.find((item) => item.kind === 'privacy_notice')!;
    assert.equal((await service.validateDocument('offer', offer.document)).evidenceMode, 'demonstration');
    assert.equal((await service.validateDocument('privacy_notice', privacy.document)).evidenceMode, 'demonstration');
    await assert.rejects(
        service.validateDocument('offer', { ...offer.document, documentVersion: offer.document.documentVersion + 1 }),
        /stale|mismatched/i,
    );
    await assert.rejects(service.validateDocument('offer', privacy.document), /stale|mismatched/i);
});

await test('registration v2 keeps offer acceptance and privacy acknowledgement distinct and immutable', () => {
    const offer = demonstrationDocument('offer', 0).document;
    const privacy = demonstrationDocument('privacy_notice', 1).document;
    assert.equal(
        registrationLegalEvidenceSchema.safeParse({
            offerAcceptance: { accepted: true, document: offer },
            privacyAcknowledgement: { acknowledged: true, document: privacy },
        }).success,
        true,
    );
    assert.equal(
        registrationLegalEvidenceSchema.safeParse({
            offerAcceptance: { accepted: true, document: offer },
            privacyAcknowledgement: { acknowledged: false, document: privacy },
        }).success,
        false,
    );
    assert.equal(
        immutableLegalDocumentRefSchema.safeParse({ ...offer, bodyHash: `sha256:${'a'.repeat(63)}` }).success,
        false,
    );
});

await test('consent-required exceptions expose stable feature-specific codes and CTA details', () => {
    const exception = new LegalConsentRequiredException('ai_data_access', 'ai.personal_data', {
        href: '/settings/privacy',
        label: 'Ознакомиться и согласиться',
    });
    assert.equal(exception.getStatus(), 403);
    assert.equal(exception.code, 'AI_PROCESSING_CONSENT_REQUIRED');
    assert.deepEqual(exception.details, {
        consentKind: 'ai_data_access',
        feature: 'ai.personal_data',
        action: { href: '/settings/privacy', label: 'Ознакомиться и согласиться' },
    });
    assert.equal(
        new LegalConsentRequiredException('marketing', 'marketing.delivery', null).code,
        'MARKETING_CONSENT_REQUIRED',
    );
});

await test('production never enables a demonstration, stale or hash-mismatched acceptance', () => {
    const current = demonstrationDocument('ai_data_access', 2).document;
    assert.equal(
        consentEvidenceEnables({
            expectedEvidenceMode: 'approved',
            action: 'accepted',
            evidenceMode: 'demonstration',
            document: current,
            currentDocument: current,
        }),
        false,
    );
    assert.equal(
        consentEvidenceEnables({
            expectedEvidenceMode: 'approved',
            action: 'accepted',
            evidenceMode: 'approved',
            document: current,
            currentDocument: { ...current, documentVersion: 2 },
        }),
        false,
    );
    assert.equal(
        consentEvidenceEnables({
            expectedEvidenceMode: 'approved',
            action: 'accepted',
            evidenceMode: 'approved',
            document: current,
            currentDocument: current,
        }),
        true,
    );
    assert.equal(
        consentEvidenceEnables({
            expectedEvidenceMode: 'demonstration',
            action: 'accepted',
            evidenceMode: 'demonstration',
            document: current,
            currentDocument: current,
        }),
        true,
    );
});

await test('only allergen preference fields require special-category consent', () => {
    const current = { allergens: ['milk'], allergenMode: 'warn', goals: ['balanced'] };
    assert.equal(allergenPreferencesChanged(current, { ...current, goals: ['protein'] }), false);
    assert.equal(allergenPreferencesChanged(current, { ...current, allergens: ['nuts'] }), true);
    assert.equal(allergenPreferencesChanged(current, { ...current, allergenMode: 'strict' }), true);
});

await test('marketing consent gates delivery without changing channel preferences', () => {
    assert.equal(marketingDeliveryAllowed('marketing', false), false);
    assert.equal(marketingDeliveryAllowed('marketing', true), true);
    assert.equal(marketingDeliveryAllowed('service', false), true);
});

await test('prepared migration v25 is manifest-bound, append-only and unapplied', () => {
    const migration = readFileSync('database/migrations/025_legal_consents.sql', 'utf8');
    const manifest = JSON.parse(readFileSync('database/manifest.json', 'utf8')) as {
        migrations: Array<{ version: number; file: string; sha256: string }>;
    };
    assert.deepEqual(
        manifest.migrations.find(({ version }) => version === 25),
        {
            version: 25,
            file: '025_legal_consents.sql',
            sha256: createHash('sha256').update(migration).digest('hex'),
        },
    );
    assert.match(migration, /CREATE TABLE meal\.agreement_acceptance_events/);
    assert.match(migration, /CREATE TABLE meal\.legal_consent_events/);
    assert.match(migration, /reject_immutable_legal_event_mutation/);
    assert.doesNotMatch(migration, /INSERT INTO meal\.(?:legal_documents|legal_document_publications)/i);
});
