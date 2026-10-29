import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../shared/config/app-config.js';
import { DatabaseService } from '../infrastructure/database/database.service.js';
import { WorkerRuntimeFactory } from '../infrastructure/workers/worker-runtime.factory.js';
import { AdminWorkerRuntimeSink } from '../modules/telemetry/runtime-telemetry.js';
import { TelemetryRepository } from '../modules/telemetry/telemetry.repository.js';
import { TelemetryService } from '../modules/telemetry/telemetry.service.js';
import { OperationalMaintenanceService } from '../modules/admin-operations/operational-maintenance.service.js';
import { AdminGovernanceService } from '../modules/admin-governance/admin-governance.service.js';
import { AdminAccessService } from '../modules/admin-auth/admin-access.service.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { ScheduledNewsRunner } from '../modules/admin-news/scheduled-news.runner.js';
import { EntitlementsService } from '../modules/entitlements/entitlements.service.js';
import { LegalConsentService } from '../modules/legal-consents/legal-consent.service.js';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
} from '../modules/legal-consents/legal-document.provider.js';
import { DiaryService } from '../modules/diary/diary.service.js';
import { ProAccessService } from '../modules/pro-overview/pro-access.service.js';
import { CookingLifecycleService } from '../modules/cooking/cooking-lifecycle.service.js';

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
            ],
        };
    }
}
