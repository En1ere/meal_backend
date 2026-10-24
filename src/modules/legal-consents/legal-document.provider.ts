import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../app/config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import {
    LEGAL_CONSENT_CONTRACT_VERSION,
    type ImmutableLegalDocumentRef,
    type PublicLegalDocument,
    publicLegalManifestSchema,
} from './legal-consent.contracts.js';

export const LEGAL_DOCUMENT_PROVIDER = Symbol('LEGAL_DOCUMENT_PROVIDER');
export interface LegalDocumentProvider {
    manifest(): Promise<ReturnType<typeof publicLegalManifestSchema.parse>>;
}

const DEMO_RELEASE = '00000000-0000-4000-8000-000000000001';
const DEMO_PUBLISH = '00000000-0000-4000-8000-000000000002';
const demoKinds = [
    'offer',
    'privacy_notice',
    'ai_data_access',
    'special_category',
    'dissemination',
    'marketing',
] as const;
export const demonstrationDocument = (kind: (typeof demoKinds)[number], index: number): PublicLegalDocument => ({
    kind,
    required: kind === 'offer' || kind === 'privacy_notice',
    withdrawalSupported: !['offer', 'privacy_notice'].includes(kind),
    document: {
        documentId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        documentVersion: 1,
        bodyHash: `sha256:${String(index + 1).repeat(64)}`,
        contentReleaseId: DEMO_RELEASE,
        publishEventId: DEMO_PUBLISH,
    },
    effectiveAt: '2026-01-01T00:00:00.000Z',
    publicUrl: null,
    locale: 'ru-RU',
    jurisdiction: 'demonstration',
    status: 'demonstration',
});

@Injectable()
export class DatabaseLegalDocumentProvider implements LegalDocumentProvider {
    constructor(
        private readonly database: DatabaseService,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    async manifest() {
        if (this.config.NODE_ENV !== 'production')
            return publicLegalManifestSchema.parse({
                contractVersion: LEGAL_CONSENT_CONTRACT_VERSION,
                status: 'demonstration',
                documents: demoKinds.map(demonstrationDocument),
            });
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        const result = await sql<{
            kind: PublicLegalDocument['kind'];
            documentId: string;
            documentVersion: string;
            bodyHash: string;
            contentReleaseId: string;
            publishEventId: string;
            effectiveAt: Date;
            publicUrl: string;
            locale: string;
            jurisdiction: string;
        }>`select d.kind, d.id "documentId", d.version "documentVersion", d.body_hash "bodyHash",
                   p.content_release_id "contentReleaseId", p.publish_event_id "publishEventId",
                   d.effective_at "effectiveAt", p.public_url "publicUrl", p.locale, p.jurisdiction
              from meal.legal_documents d
              join meal.legal_document_publications p on p.document_id=d.id
             where p.approved_at is not null and p.retired_at is null and d.effective_at<=now()
               and d.kind in ('offer','privacy_notice','ai_data_access','special_category','dissemination','marketing')
             order by d.kind,d.version desc`.execute(this.database.db);
        const seen = new Set<string>();
        const documents = result.rows.flatMap((row) => {
            if (seen.has(row.kind)) return [];
            seen.add(row.kind);
            return [
                {
                    kind: row.kind,
                    required: row.kind === 'offer' || row.kind === 'privacy_notice',
                    withdrawalSupported: !['offer', 'privacy_notice'].includes(row.kind),
                    document: {
                        documentId: row.documentId,
                        documentVersion: Number(row.documentVersion),
                        bodyHash: row.bodyHash.startsWith('sha256:') ? row.bodyHash : `sha256:${row.bodyHash}`,
                        contentReleaseId: row.contentReleaseId,
                        publishEventId: row.publishEventId,
                    } satisfies ImmutableLegalDocumentRef,
                    effectiveAt: new Date(row.effectiveAt).toISOString(),
                    publicUrl: row.publicUrl,
                    locale: row.locale,
                    jurisdiction: row.jurisdiction,
                    status: 'approved' as const,
                },
            ];
        });
        if (documents.length !== demoKinds.length)
            throw new ServiceUnavailableException('Approved legal manifest unavailable');
        return publicLegalManifestSchema.parse({
            contractVersion: LEGAL_CONSENT_CONTRACT_VERSION,
            status: 'approved',
            documents,
        });
    }
}
