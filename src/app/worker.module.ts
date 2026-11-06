import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../shared/config/app-config.js';
import { DatabaseService } from '../infrastructure/database/database.service.js';
import { WorkerRuntimeFactory } from '../infrastructure/workers/worker-runtime.factory.js';
import { AdminWorkerRuntimeSink, TelemetryRepository, TelemetryService } from '../modules/telemetry/public.js';
import { OperationalMaintenanceService } from '../modules/admin-operations/public.js';
import { AdminGovernanceService } from '../modules/admin-governance/public.js';
import { AdminAccessService } from '../modules/admin-auth/public.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { ScheduledNewsRunner } from '../modules/admin-news/public.js';
import { EntitlementsService } from '../modules/entitlements/public.js';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
    LegalConsentService,
} from '../modules/legal-consents/public.js';
import { DiaryService } from '../modules/diary/public.js';
import { ProAccessService } from '../modules/pro-overview/public.js';
import { CookingLifecycleService } from '../modules/cooking/public.js';
import { AiContentRetentionService } from '../modules/ai/public.js';

@Module({})
export class WorkerModule {
    static configure(config: AppConfig): DynamicModule {
        return {
            module: WorkerModule,
            providers: [
                { provide: APP_CONFIG, useValue: config },
                DatabaseService,
                TelemetryRepository,
                TelemetryService,
                AdminWorkerRuntimeSink,
                WorkerRuntimeFactory,
                OperationalMaintenanceService,
                AuthService,
                AdminAccessService,
                AdminGovernanceService,
                EntitlementsService,
                DatabaseLegalDocumentProvider,
                { provide: LEGAL_DOCUMENT_PROVIDER, useExisting: DatabaseLegalDocumentProvider },
                LegalConsentService,
                ScheduledNewsRunner,
                ProAccessService,
                DiaryService,
                CookingLifecycleService,
                AiContentRetentionService,
            ],
        };
    }
}
