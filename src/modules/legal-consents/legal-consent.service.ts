import { ConflictException, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import {
    blockedFeatures,
    consentAcceptSchema,
    consentHistorySchema,
    consentRevokeSchema,
    consentStateSchema,
    immutableLegalDocumentRefSchema,
    LEGAL_CONSENT_CONTRACT_VERSION,
    type ImmutableLegalDocumentRef,
    type OptionalConsentKind,
} from './legal-consent.contracts.js';
import { LEGAL_DOCUMENT_PROVIDER, type LegalDocumentProvider } from './legal-document.provider.js';

type Tx = Transaction<DatabaseSchema>;
type Connection = Kysely<DatabaseSchema> | Tx;
const kinds = ['ai_data_access', 'special_category', 'dissemination', 'marketing'] as const;
function sameDocument(left: ImmutableLegalDocumentRef, right: ImmutableLegalDocumentRef) {
    return Object.keys(left).every(
        (key) => left[key as keyof ImmutableLegalDocumentRef] === right[key as keyof ImmutableLegalDocumentRef],
    );
}
export function consentEvidenceEnables(input: {
    production: boolean;
    action: 'accepted' | 'revoked' | undefined;
    evidenceMode: 'approved' | 'demonstration' | undefined;
    document: unknown;
    approvedDocument: ImmutableLegalDocumentRef | undefined;
}) {
    if (input.action !== 'accepted') return false;
    if (!input.production) return true;
    const snapshot = immutableLegalDocumentRefSchema.safeParse(input.document);
    return (
        input.evidenceMode === 'approved' &&
        snapshot.success &&
        !!input.approvedDocument &&
        sameDocument(snapshot.data, input.approvedDocument)
    );
}

const requiredCodes = {
    ai_data_access: 'AI_PROCESSING_CONSENT_REQUIRED',
    special_category: 'SPECIAL_CATEGORY_CONSENT_REQUIRED',
    dissemination: 'DISSEMINATION_CONSENT_REQUIRED',
    marketing: 'MARKETING_CONSENT_REQUIRED',
} as const;
export class LegalConsentRequiredException extends HttpException {
    readonly code: (typeof requiredCodes)[OptionalConsentKind];
    readonly details: {
        consentKind: OptionalConsentKind;
        feature: string;
        action: { href: string; label: string } | null;
    };
    constructor(kind: OptionalConsentKind, feature: string, action: { href: string; label: string } | null) {
        super('Legal consent required', 403);
        this.code = requiredCodes[kind];
        this.details = { consentKind: kind, feature, action };
    }
}

@Injectable()
export class LegalConsentService {
    constructor(
        private readonly database: DatabaseService,
        @Inject(LEGAL_DOCUMENT_PROVIDER) private readonly documents: LegalDocumentProvider,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    manifest() {
        return this.documents.manifest();
    }
    private async currentDocument(kind: string) {
        const manifest = await this.manifest();
        const document = manifest.documents.find((item) => item.kind === kind);
        if (!document || manifest.status === 'unavailable')
            throw new ServiceUnavailableException('Legal document unavailable');
        return { manifest, document };
    }
    async validateDocument(kind: string, supplied: ImmutableLegalDocumentRef, tx?: Tx) {
        const parsed = immutableLegalDocumentRefSchema.parse(supplied);
        if (this.config.NODE_ENV === 'production') {
            if (!tx) throw new ServiceUnavailableException('Atomic legal validation requires a transaction');
            const row = await sql<{
                documentId: string;
                documentVersion: string;
                bodyHash: string;
                contentReleaseId: string;
                publishEventId: string;
            }>`select d.id "documentId",d.version "documentVersion",d.body_hash "bodyHash",
                       p.content_release_id "contentReleaseId",p.publish_event_id "publishEventId"
                  from meal.legal_documents d join meal.legal_document_publications p on p.document_id=d.id
                 where d.kind=${kind} and d.effective_at<=now() and p.approved_at is not null and p.retired_at is null
                 order by d.version desc limit 1 for share of d,p`.execute(tx);
            const approved = row.rows[0];
            if (!approved) throw new ServiceUnavailableException('Approved legal document unavailable');
            const actual = immutableLegalDocumentRefSchema.parse({
                documentId: approved.documentId,
                documentVersion: Number(approved.documentVersion),
                bodyHash: approved.bodyHash.startsWith('sha256:') ? approved.bodyHash : `sha256:${approved.bodyHash}`,
                contentReleaseId: approved.contentReleaseId,
                publishEventId: approved.publishEventId,
            });
            if (!sameDocument(actual, parsed))
                throw new ConflictException({
                    code: 'LEGAL_DOCUMENT_STALE',
                    message: 'Legal document reference is stale or mismatched.',
                });
            return { document: { document: actual }, evidenceMode: 'approved' as const };
        }
        const { manifest, document } = await this.currentDocument(kind);
        if (!sameDocument(document.document, parsed))
            throw new ConflictException({
                code: 'LEGAL_DOCUMENT_STALE',
                message: 'Legal document reference is stale or mismatched.',
            });
        return {
            document,
            evidenceMode: manifest.status === 'approved' ? ('approved' as const) : ('demonstration' as const),
        };
    }
    async recordRegistrationEvidence(
        tx: Tx,
        userId: string,
        input: {
            offerAcceptance: { document: ImmutableLegalDocumentRef };
            privacyAcknowledgement: { document: ImmutableLegalDocumentRef };
        },
        requestId: string,
    ) {
        const offer = await this.validateDocument('offer', input.offerAcceptance.document, tx);
        const privacy = await this.validateDocument('privacy_notice', input.privacyAcknowledgement.document, tx);
        if (offer.evidenceMode !== privacy.evidenceMode) throw new ConflictException('Legal evidence modes differ');
        const now = new Date();
        await tx
            .insertInto('agreement_acceptance_events')
            .values({
                id: randomUUID(),
                user_id: userId,
                agreement_kind: 'offer',
                action: 'accepted',
                document_id: offer.document.document.documentId,
                document_version: offer.document.document.documentVersion,
                body_hash: offer.document.document.bodyHash,
                content_release_id: offer.document.document.contentReleaseId,
                publish_event_id: offer.document.document.publishEventId,
                occurred_at: now,
                request_id: requestId,
                evidence_mode: offer.evidenceMode,
            })
            .execute();
        await tx
            .insertInto('legal_acknowledgement_events')
            .values({
                id: randomUUID(),
                user_id: userId,
                document_kind: 'privacy_notice',
                action: 'acknowledged',
                document_id: privacy.document.document.documentId,
                document_version: privacy.document.document.documentVersion,
                body_hash: privacy.document.document.bodyHash,
                content_release_id: privacy.document.document.contentReleaseId,
                publish_event_id: privacy.document.document.publishEventId,
                occurred_at: now,
                request_id: requestId,
                evidence_mode: privacy.evidenceMode,
            })
            .execute();
    }
    async state(userId: string, connection?: Connection) {
        const db = connection ?? this.database.db;
        if (!db || (!connection && !(await this.database.ready()))) throw new ServiceUnavailableException();
        const rows = await sql<{
            kind: OptionalConsentKind;
            action: 'accepted' | 'revoked';
            occurredAt: Date;
            revision: string;
            document: unknown;
            evidenceMode: 'approved' | 'demonstration';
        }>`
            select distinct on(kind) kind,action,occurred_at "occurredAt",revision,
                   document_snapshot "document",evidence_mode "evidenceMode"
            from meal.legal_consent_events where user_id=${userId}::uuid order by kind,revision desc`.execute(db);
        const byKind = new Map(rows.rows.map((row) => [row.kind, row]));
        const approvedDocuments = new Map<OptionalConsentKind, ImmutableLegalDocumentRef>();
        let approvedDocumentCount = 0;
        if (this.config.NODE_ENV === 'production') {
            const approved = await sql<{
                kind: OptionalConsentKind;
                documentId: string;
                documentVersion: string;
                bodyHash: string;
                contentReleaseId: string;
                publishEventId: string;
            }>`select distinct on(d.kind) d.kind,d.id "documentId",d.version "documentVersion",d.body_hash "bodyHash",
                       p.content_release_id "contentReleaseId",p.publish_event_id "publishEventId"
                  from meal.legal_documents d join meal.legal_document_publications p on p.document_id=d.id
                 where d.effective_at<=now() and p.approved_at is not null and p.retired_at is null
                   and d.kind in ('offer','privacy_notice','ai_data_access','special_category','dissemination','marketing')
                 order by d.kind,d.version desc`.execute(db);
            approvedDocumentCount = approved.rows.length;
            for (const row of approved.rows) {
                if (!kinds.includes(row.kind)) continue;
                approvedDocuments.set(
                    row.kind,
                    immutableLegalDocumentRefSchema.parse({
                        documentId: row.documentId,
                        documentVersion: Number(row.documentVersion),
                        bodyHash: row.bodyHash.startsWith('sha256:') ? row.bodyHash : `sha256:${row.bodyHash}`,
                        contentReleaseId: row.contentReleaseId,
                        publishEventId: row.publishEventId,
                    }),
                );
            }
        }
        return consentStateSchema.parse({
            contractVersion: LEGAL_CONSENT_CONTRACT_VERSION,
            manifestStatus:
                this.config.NODE_ENV === 'production'
                    ? approvedDocumentCount === 6
                        ? 'approved'
                        : 'unavailable'
                    : 'demonstration',
            consents: kinds.map((kind) => {
                const row = byKind.get(kind);
                const approved = approvedDocuments.get(kind);
                const enabled = consentEvidenceEnables({
                    production: this.config.NODE_ENV === 'production',
                    action: row?.action,
                    evidenceMode: row?.evidenceMode,
                    document: row?.document,
                    approvedDocument: approved,
                });
                return {
                    kind,
                    enabled,
                    revision: Number(row?.revision ?? 0),
                    changedAt: row ? new Date(row.occurredAt).toISOString() : null,
                    document: enabled ? (row?.document ?? null) : null,
                    blockedFeatures: enabled ? [] : [...blockedFeatures[kind]],
                    action: enabled ? null : { href: '/settings/privacy', label: 'Ознакомиться и согласиться' },
                };
            }),
        });
    }
    async accept(userId: string, kind: OptionalConsentKind, raw: unknown, requestId: string) {
        const input = consentAcceptSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await sql`select id from meal.users where id=${userId}::uuid for update`.execute(tx);
            const duplicate = await tx
                .selectFrom('legal_consent_events')
                .selectAll()
                .where('user_id', '=', userId)
                .where('idempotency_key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (duplicate) {
                const snapshot = immutableLegalDocumentRefSchema.safeParse(duplicate.document_snapshot);
                if (
                    duplicate.kind !== kind ||
                    duplicate.action !== 'accepted' ||
                    !snapshot.success ||
                    !sameDocument(snapshot.data, input.document)
                )
                    throw new ConflictException('Idempotency key belongs to a different consent command');
                return this.state(userId, tx);
            }
            const current = (await this.state(userId, tx)).consents.find((item) => item.kind === kind)!;
            if (current.revision !== input.expectedRevision)
                throw new HttpException('Consent state changed. Refresh and retry.', 412);
            const binding = await this.validateDocument(kind, input.document, tx);
            await tx
                .insertInto('legal_consent_events')
                .values({
                    id: randomUUID(),
                    user_id: userId,
                    kind,
                    action: 'accepted',
                    revision: current.revision + 1,
                    document_snapshot: binding.document.document,
                    occurred_at: new Date(),
                    request_id: requestId,
                    idempotency_key: input.idempotencyKey,
                    evidence_mode: binding.evidenceMode,
                })
                .execute();
            return this.state(userId, tx);
        });
    }
    async revoke(userId: string, kind: OptionalConsentKind, raw: unknown, requestId: string) {
        const input = consentRevokeSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await sql`select id from meal.users where id=${userId}::uuid for update`.execute(tx);
            const duplicate = await tx
                .selectFrom('legal_consent_events')
                .selectAll()
                .where('user_id', '=', userId)
                .where('idempotency_key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (duplicate) {
                if (duplicate.kind !== kind || duplicate.action !== 'revoked')
                    throw new ConflictException('Idempotency key belongs to a different consent command');
                return this.state(userId, tx);
            }
            const current = (await this.state(userId, tx)).consents.find((item) => item.kind === kind)!;
            if (current.revision !== input.expectedRevision)
                throw new HttpException('Consent state changed. Refresh and retry.', 412);
            await tx
                .insertInto('legal_consent_events')
                .values({
                    id: randomUUID(),
                    user_id: userId,
                    kind,
                    action: 'revoked',
                    revision: current.revision + 1,
                    document_snapshot: null,
                    occurred_at: new Date(),
                    request_id: requestId,
                    idempotency_key: input.idempotencyKey,
                    evidence_mode: this.config.NODE_ENV === 'production' ? 'approved' : 'demonstration',
                })
                .execute();
            return this.state(userId, tx);
        });
    }
    async history(userId: string) {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        const rows = await this.database.db
            .selectFrom('legal_consent_events')
            .selectAll()
            .where('user_id', '=', userId)
            .orderBy('occurred_at', 'desc')
            .limit(100)
            .execute();
        return consentHistorySchema.parse({
            events: rows.map((row) => ({
                id: row.id,
                kind: row.kind,
                action: row.action,
                occurredAt: new Date(row.occurred_at).toISOString(),
                document: row.document_snapshot,
                evidenceMode: row.evidence_mode,
            })),
        });
    }
    async assertFeatureAccess(userId: string, kind: OptionalConsentKind, feature: string, connection?: Connection) {
        const item = (await this.state(userId, connection)).consents.find((consent) => consent.kind === kind)!;
        if (!item.enabled) throw new LegalConsentRequiredException(kind, feature, item.action);
    }
    async allowsFeatureAccess(userId: string, kind: OptionalConsentKind, connection?: Connection) {
        const item = (await this.state(userId, connection)).consents.find((consent) => consent.kind === kind)!;
        return item.enabled;
    }
}
