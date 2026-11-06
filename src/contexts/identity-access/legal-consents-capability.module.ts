import { Module } from '@nestjs/common';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
    LegalConsentController,
    LegalConsentGuard,
    LegalConsentService,
    PublicLegalController,
} from '../../modules/legal-consents/public.js';

@Module({
    controllers: [PublicLegalController, LegalConsentController],
    providers: [
        LegalConsentService,
        LegalConsentGuard,
        DatabaseLegalDocumentProvider,
        { provide: LEGAL_DOCUMENT_PROVIDER, useExisting: DatabaseLegalDocumentProvider },
    ],
    exports: [LegalConsentService],
})
export class LegalConsentsCapabilityModule {}
