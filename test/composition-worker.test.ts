import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app/app.module.js';
import { readConfig } from '../src/app/config.js';
import { WorkerModule } from '../src/app/worker.module.js';
import { ContentReleasesCapabilityModule } from '../src/contexts/community-content/content-releases-capability.module.js';
import { AdminSupportCapabilityModule } from '../src/contexts/community-content/admin-support-capability.module.js';
import { AdminContentCapabilityModule } from '../src/contexts/community-content/admin-content-capability.module.js';
import { AdminReviewCapabilityModule } from '../src/contexts/community-content/admin-review-capability.module.js';
import { ModeratorCapabilityModule } from '../src/contexts/community-content/moderator-capability.module.js';
import { AiAppealsCapabilityModule } from '../src/contexts/community-content/ai-appeals-capability.module.js';
import { CommunityCapabilityModule } from '../src/contexts/community-content/community-capability.module.js';
import { SupportCapabilityModule } from '../src/contexts/community-content/support-capability.module.js';
import { AdminNewsCapabilityModule } from '../src/contexts/community-content/admin-news-capability.module.js';
import { LegalConsentsCapabilityModule } from '../src/contexts/identity-access/legal-consents-capability.module.js';
import { PrivacyCapabilityModule } from '../src/contexts/identity-access/privacy-capability.module.js';
import { ProfilesCapabilityModule } from '../src/contexts/identity-access/profiles-capability.module.js';
import { CriticalReauthCapabilityModule } from '../src/contexts/identity-access/critical-reauth-capability.module.js';
import { ExportsCapabilityModule } from '../src/contexts/identity-access/exports-capability.module.js';
import { AccountLifecycleCapabilityModule } from '../src/contexts/identity-access/account-lifecycle-capability.module.js';
import { AdminAuthCapabilityModule } from '../src/contexts/identity-access/admin-auth-capability.module.js';
import { AdminReadBoundaryCapabilityModule } from '../src/contexts/identity-access/admin-read-boundary-capability.module.js';
import { AdminReadCapabilityModule } from '../src/contexts/identity-access/admin-read-capability.module.js';
import { RegistrationRiskCapabilityModule } from '../src/contexts/identity-access/registration-risk-capability.module.js';
import { AccountMailOutboxCapabilityModule } from '../src/contexts/identity-access/account-mail-outbox-capability.module.js';
import { AccountServiceCapabilityModule } from '../src/contexts/identity-access/account-service-capability.module.js';
import { AccountHttpCapabilityModule } from '../src/contexts/identity-access/account-http-capability.module.js';
import { UserAuthHttpCapabilityModule } from '../src/contexts/identity-access/user-auth-http-capability.module.js';
import { StaffAuthHttpCapabilityModule } from '../src/contexts/identity-access/staff-auth-http-capability.module.js';
import { AdminFreeAiCapabilityModule } from '../src/contexts/integrations/admin-free-ai-capability.module.js';
import { OcrCapabilityModule } from '../src/contexts/integrations/ocr-capability.module.js';
import { SecretProviderCapabilityModule } from '../src/contexts/integrations/secret-provider-capability.module.js';
import { ProviderObservationCapabilityModule } from '../src/contexts/integrations/provider-observation-capability.module.js';
import { NotificationsCapabilityModule } from '../src/contexts/integrations/notifications-capability.module.js';
import { AiProviderCapabilityModule } from '../src/contexts/integrations/ai-provider-capability.module.js';
import { AiCapabilityModule } from '../src/contexts/integrations/ai-capability.module.js';
import { CookingCapabilityModule } from '../src/contexts/catalog-recipes/cooking-capability.module.js';
import { SearchCapabilityModule } from '../src/contexts/catalog-recipes/search-capability.module.js';
import { RecipeWorkspaceCapabilityModule } from '../src/contexts/catalog-recipes/recipe-workspace-capability.module.js';
import { ProAccessCapabilityModule } from '../src/contexts/household-entitlements/pro-access-capability.module.js';
import { ProOverviewCapabilityModule } from '../src/contexts/household-entitlements/pro-overview-capability.module.js';
import { FamilyNotesCapabilityModule } from '../src/contexts/household-entitlements/family-notes-capability.module.js';
import { FamilyChatCapabilityModule } from '../src/contexts/household-entitlements/family-chat-capability.module.js';
import { SubscriptionSettingsCapabilityModule } from '../src/contexts/household-entitlements/subscription-settings-capability.module.js';
import { FamilyCapabilityModule } from '../src/contexts/household-entitlements/family-capability.module.js';
import { ReceiptsCapabilityModule } from '../src/contexts/inventory-commerce/receipts-capability.module.js';
import { ShoppingCapabilityModule } from '../src/contexts/inventory-commerce/shopping-capability.module.js';
import { InventoryIngestCapabilityModule } from '../src/contexts/inventory-commerce/inventory-ingest-capability.module.js';
import { PricingCapabilityModule } from '../src/contexts/inventory-commerce/pricing-capability.module.js';
import { FinanceCapabilityModule } from '../src/contexts/inventory-commerce/finance-capability.module.js';
import { PaymentProviderCapabilityModule } from '../src/contexts/inventory-commerce/payment-provider-capability.module.js';
import { RefundProviderCapabilityModule } from '../src/contexts/inventory-commerce/refund-provider-capability.module.js';
import { PaymentRepositoryCapabilityModule } from '../src/contexts/inventory-commerce/payment-repository-capability.module.js';
import { PaymentApplicationCapabilityModule } from '../src/contexts/inventory-commerce/payment-application-capability.module.js';
import { AdminBillingCapabilityModule } from '../src/contexts/inventory-commerce/admin-billing-capability.module.js';
import { DiaryCapabilityModule } from '../src/contexts/planning-health/diary-capability.module.js';
import { MealPlanCapabilityModule } from '../src/contexts/planning-health/meal-plan-capability.module.js';
import { PersonalizationCapabilityModule } from '../src/contexts/planning-health/personalization-capability.module.js';
import { NutritionCapabilityModule } from '../src/contexts/planning-health/nutrition-capability.module.js';
import { TelemetryCapabilityModule } from '../src/contexts/platform-operations/telemetry-capability.module.js';
import { OperationalRuntimeCapabilityModule } from '../src/contexts/platform-operations/operational-runtime-capability.module.js';
import { HealthCapabilityModule } from '../src/contexts/platform-operations/health-capability.module.js';
import { AdminNotificationsCapabilityModule } from '../src/contexts/platform-operations/admin-notifications-capability.module.js';
import { AdminActionsCapabilityModule } from '../src/contexts/platform-operations/admin-actions-capability.module.js';
import { AdminOperationsCapabilityModule } from '../src/contexts/platform-operations/admin-operations-capability.module.js';
import { AdminAcceptanceTestsCapabilityModule } from '../src/contexts/platform-operations/admin-acceptance-tests-capability.module.js';
import { AdminObservabilityCapabilityModule } from '../src/contexts/platform-operations/admin-observability-capability.module.js';
import { AdminGovernanceCapabilityModule } from '../src/contexts/platform-operations/admin-governance-capability.module.js';
import { AdminRuntimeSettingsCapabilityModule } from '../src/contexts/platform-operations/admin-runtime-settings-capability.module.js';
import { AdminAuthController, AdminReadBoundary } from '../src/modules/admin-auth/public.js';
import {
    AdminObservabilityRepository,
    AdminObservabilityService,
    HostSnapshotReader,
} from '../src/modules/admin-observability/public.js';
import {
    AuthController,
    STAFF_SESSION_GUARD,
    StaffAuthController,
    StaffSessionGuard,
    StaffSessionRouteGuard,
} from '../src/modules/auth/public.js';
import {
    DisabledMediaObjectStore,
    MEDIA_OBJECT_STORE,
    MediaStorageController,
    MediaStorageService,
    S3MediaObjectStore,
} from '../src/modules/media-storage/public.js';
import { MediaObjectStoreCapabilityModule } from '../src/contexts/integrations/media-object-store-capability.module.js';
import { MediaStorageCapabilityModule } from '../src/contexts/integrations/media-storage-capability.module.js';
import { ObjectStorageProviderCapabilityModule } from '../src/contexts/integrations/object-storage-provider-capability.module.js';
import { KeyManagementProviderCapabilityModule } from '../src/contexts/integrations/key-management-provider-capability.module.js';
import { MalwareScannerProviderCapabilityModule } from '../src/contexts/integrations/malware-scanner-provider-capability.module.js';
import { EmailDeliveryProviderCapabilityModule } from '../src/contexts/integrations/email-delivery-provider-capability.module.js';
import { WebPushDeliveryProviderCapabilityModule } from '../src/contexts/integrations/web-push-delivery-provider-capability.module.js';
import {
    DisabledEmailDeliveryProvider,
    DisabledWebPushDeliveryProvider,
    EMAIL_DELIVERY_PROVIDER,
    VapidWebPushProvider,
    WEB_PUSH_DELIVERY_PROVIDER,
} from '../src/modules/delivery-infrastructure/public.js';
import {
    DisabledKeyManagementProvider,
    DisabledMalwareScannerProvider,
    DisabledObjectStorageProvider,
    KEY_MANAGEMENT_PROVIDER,
    MALWARE_SCANNER_PROVIDER,
    OBJECT_STORAGE_PROVIDER,
} from '../src/modules/media-infrastructure/public.js';
import { AiContentRetentionService, AiProvider, AiReconciliationService, AiService } from '../src/modules/ai/public.js';
import { AiAppealsService } from '../src/modules/ai-appeals/public.js';
import {
    ACCOUNT_MAIL_OUTBOX,
    AccountController,
    AccountService,
    DisabledAccountMailOutbox,
    MailboxController,
    PostgresAccountMailOutbox,
    RegistrationRiskPolicy,
} from '../src/modules/account/public.js';
import { AccountLifecycleService, CriticalReauthService } from '../src/modules/account-lifecycle/public.js';
import { AdminContentService } from '../src/modules/admin-content/public.js';
import { AdminReadService } from '../src/modules/admin/public.js';
import { AdminRuntimeSettingsService, LocalBackupStatusReader } from '../src/modules/admin-runtime-settings/public.js';
import { AdminActionsService } from '../src/modules/admin-actions/public.js';
import { OperationalMaintenanceService, OperationsWorkspaceService } from '../src/modules/admin-operations/public.js';
import { AdminGovernanceService } from '../src/modules/admin-governance/public.js';
import { AdminFreeAiService } from '../src/modules/admin-free-ai/public.js';
import {
    AdminAcceptanceTestsRepository,
    AdminAcceptanceTestsService,
} from '../src/modules/admin-acceptance-tests/public.js';
import { DisabledOcrProvider, OCR_PROVIDER } from '../src/modules/ocr-infrastructure/public.js';
import { NotificationCenterService } from '../src/modules/admin-notifications/public.js';
import { AdminSupportService } from '../src/modules/admin-support/public.js';
import {
    AdminNewsController,
    AdminNewsService,
    NewsPublicController,
    NewsPublicService,
    ScheduledNewsRunner,
} from '../src/modules/admin-news/public.js';
import { AdminBillingController, AdminBillingService } from '../src/modules/admin-billing/public.js';
import { AdminReviewService, AdminRollbackRegistry } from '../src/modules/admin-review/public.js';
import { CookingLifecycleService, CookingService, CookingStatisticsPolicy } from '../src/modules/cooking/public.js';
import { ContentReleasesService } from '../src/modules/content-releases/public.js';
import { CommunityService } from '../src/modules/community/public.js';
import { FamilyNotesService } from '../src/modules/family-notes/public.js';
import { FamilyChatService } from '../src/modules/family-chat/public.js';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
    LegalConsentService,
} from '../src/modules/legal-consents/public.js';
import { InventoryIngestService } from '../src/modules/inventory-ingest/public.js';
import { ModeratorService, ModeratorSessionGuard } from '../src/modules/moderator/public.js';
import { PersonalizationService } from '../src/modules/personalization/public.js';
import { PrivacyService } from '../src/modules/privacy/public.js';
import { RecipeWorkspaceService } from '../src/modules/recipe-workspace/public.js';
import { ShoppingService } from '../src/modules/shopping/public.js';
import { SearchService } from '../src/modules/search/public.js';
import { SupportService } from '../src/modules/support/public.js';
import { DiaryService } from '../src/modules/diary/public.js';
import { ExportsService } from '../src/modules/exports/public.js';
import { FinanceService, PricingService } from '../src/modules/finance/public.js';
import { SubscriptionSettingsService } from '../src/modules/subscription-settings/public.js';
import { FamilyService } from '../src/modules/family/public.js';
import { MealPlanService } from '../src/modules/meal-plan/public.js';
import { NutritionService } from '../src/modules/nutrition/public.js';
import { NotificationsService, WebPushSubscriptionsService } from '../src/modules/notifications/public.js';
import { ProfilesService } from '../src/modules/profiles/public.js';
import { ProAccessService, ProOverviewService } from '../src/modules/pro-overview/public.js';
import {
    DisabledPaymentProvider,
    DisabledRefundProvider,
    PAYMENT_PROVIDER,
    PAYMENT_REPOSITORY,
    PaymentApplicationService,
    PostgresPaymentRepository,
    REFUND_PROVIDER,
} from '../src/modules/payments/public.js';
import { PurchasesService, ReceiptsService } from '../src/modules/receipts/public.js';
import { AdminWorkerRuntimeSink, TelemetryRepository, TelemetryService } from '../src/modules/telemetry/public.js';
import { DisabledSecretProvider, ProviderObserver, SECRET_PROVIDER } from '../src/modules/provider-runtime/public.js';

const config = readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const providerToken = (provider: Provider): unknown =>
    typeof provider === 'object' && provider !== null && 'provide' in provider ? provider.provide : provider;

void test('worker composition remains an exact isolated process scope', () => {
    const worker = WorkerModule.configure(config);
    const workerProviders = (worker.providers ?? []).map(providerToken);
    assert.deepEqual(worker.imports ?? [], []);
    assert.equal(workerProviders.length, 19);

    const httpProviderTokens = new Set<unknown>();
    const visitedModules = new Set<unknown>();
    const visitHttpModule = (candidate: unknown): void => {
        const dynamic =
            typeof candidate === 'object' && candidate !== null && 'module' in candidate
                ? (candidate as DynamicModule)
                : null;
        const moduleClass = dynamic?.module ?? candidate;
        if (visitedModules.has(moduleClass)) return;
        visitedModules.add(moduleClass);
        const providers =
            dynamic?.providers ??
            (typeof moduleClass === 'function'
                ? (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleClass) as Provider[] | undefined)
                : []) ??
            [];
        const imports =
            dynamic?.imports ??
            (typeof moduleClass === 'function'
                ? (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) as unknown[] | undefined)
                : []) ??
            [];
        for (const provider of providers) httpProviderTokens.add(providerToken(provider));
        for (const imported of imports) visitHttpModule(imported);
    };
    visitHttpModule(AppModule.configure(config));
    const tokenName = (token: unknown): string =>
        typeof token === 'symbol'
            ? `Symbol(${token.description ?? ''})`
            : typeof token === 'function'
              ? token.name
              : String(token);
    const processScopedOverlap = [...new Set(workerProviders)]
        .filter((token) => httpProviderTokens.has(token))
        .map(tokenName)
        .sort();
    assert.deepEqual(processScopedOverlap, [
        'AdminAccessService',
        'AdminGovernanceService',
        'AdminWorkerRuntimeSink',
        'AuthService',
        'CookingLifecycleService',
        'DatabaseLegalDocumentProvider',
        'DatabaseService',
        'DiaryService',
        'EntitlementsService',
        'LegalConsentService',
        'OperationalMaintenanceService',
        'ProAccessService',
        'ScheduledNewsRunner',
        'Symbol(APP_CONFIG)',
        'Symbol(LEGAL_DOCUMENT_PROVIDER)',
        'TelemetryRepository',
        'TelemetryService',
        'WorkerRuntimeFactory',
    ]);
    assert.equal(processScopedOverlap.length, workerProviders.length - 1);
    assert.equal(httpProviderTokens.has(AiContentRetentionService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(TelemetryCapabilityModule), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ProviderObservationCapabilityModule), false);
    assert.equal(workerProviders.includes(ProviderObserver), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PersonalizationCapabilityModule), false);
    assert.equal(workerProviders.includes(PersonalizationService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(FamilyChatCapabilityModule), false);
    assert.equal(workerProviders.includes(FamilyChatService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(NutritionCapabilityModule), false);
    assert.equal(workerProviders.includes(NutritionService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(InventoryIngestCapabilityModule), false);
    assert.equal(workerProviders.includes(InventoryIngestService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminOperationsCapabilityModule), false);
    assert.equal(workerProviders.includes(OperationsWorkspaceService), false);
    assert.equal(workerProviders.includes(OperationalMaintenanceService), true);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(CriticalReauthCapabilityModule), false);
    assert.equal(workerProviders.includes(CriticalReauthService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ExportsCapabilityModule), false);
    assert.equal(workerProviders.includes(ExportsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminGovernanceCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminGovernanceService), true);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AccountLifecycleCapabilityModule), false);
    assert.equal(workerProviders.includes(AccountLifecycleService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(RecipeWorkspaceCapabilityModule), false);
    assert.equal(workerProviders.includes(RecipeWorkspaceService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminAuthCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminAuthController), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminAcceptanceTestsCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminAcceptanceTestsRepository), false);
    assert.equal(workerProviders.includes(AdminAcceptanceTestsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(NotificationsCapabilityModule), false);
    assert.equal(workerProviders.includes(NotificationsService), false);
    assert.equal(workerProviders.includes(WebPushSubscriptionsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminReadBoundaryCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminReadBoundary), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminObservabilityCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminObservabilityRepository), false);
    assert.equal(workerProviders.includes(AdminObservabilityService), false);
    assert.equal(workerProviders.includes(HostSnapshotReader), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminContentCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminContentService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminReadCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminReadService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminRuntimeSettingsCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminRuntimeSettingsService), false);
    assert.equal(workerProviders.includes(LocalBackupStatusReader), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminReviewCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminReviewService), false);
    assert.equal(workerProviders.includes(AdminRollbackRegistry), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ModeratorCapabilityModule), false);
    assert.equal(workerProviders.includes(ModeratorService), false);
    assert.equal(workerProviders.includes(ModeratorSessionGuard), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PricingCapabilityModule), false);
    assert.equal(workerProviders.includes(PricingService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(FinanceCapabilityModule), false);
    assert.equal(workerProviders.includes(FinanceService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(SubscriptionSettingsCapabilityModule), false);
    assert.equal(workerProviders.includes(SubscriptionSettingsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(FamilyCapabilityModule), false);
    assert.equal(workerProviders.includes(FamilyService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AiProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(AiProvider), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AiCapabilityModule), false);
    assert.equal(workerProviders.includes(AiService), false);
    assert.equal(workerProviders.includes(AiReconciliationService), false);
    assert.equal(workerProviders.includes(AiContentRetentionService), true);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ProOverviewCapabilityModule), false);
    assert.equal(workerProviders.includes(ProOverviewService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PaymentProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledPaymentProvider), false);
    assert.equal(workerProviders.includes(PAYMENT_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(RefundProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledRefundProvider), false);
    assert.equal(workerProviders.includes(REFUND_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PaymentRepositoryCapabilityModule), false);
    assert.equal(workerProviders.includes(PostgresPaymentRepository), false);
    assert.equal(workerProviders.includes(PAYMENT_REPOSITORY), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PaymentApplicationCapabilityModule), false);
    assert.equal(workerProviders.includes(PaymentApplicationService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminBillingCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminBillingService), false);
    assert.equal(workerProviders.includes(AdminBillingController), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminNewsCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminNewsService), false);
    assert.equal(workerProviders.includes(NewsPublicService), false);
    assert.equal(workerProviders.includes(AdminNewsController), false);
    assert.equal(workerProviders.includes(NewsPublicController), false);
    assert.equal(workerProviders.includes(ScheduledNewsRunner), true);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(RegistrationRiskCapabilityModule), false);
    assert.equal(workerProviders.includes(RegistrationRiskPolicy), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AccountMailOutboxCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledAccountMailOutbox), false);
    assert.equal(workerProviders.includes(PostgresAccountMailOutbox), false);
    assert.equal(workerProviders.includes(ACCOUNT_MAIL_OUTBOX), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AccountServiceCapabilityModule), false);
    assert.equal(workerProviders.includes(AccountService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AccountHttpCapabilityModule), false);
    assert.equal(workerProviders.includes(AccountController), false);
    assert.equal(workerProviders.includes(MailboxController), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(UserAuthHttpCapabilityModule), false);
    assert.equal(workerProviders.includes(AuthController), false);
    assert.equal(workerProviders.includes(StaffSessionGuard), false);
    assert.equal(workerProviders.includes(STAFF_SESSION_GUARD), false);
    assert.equal(workerProviders.includes(StaffSessionRouteGuard), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(StaffAuthHttpCapabilityModule), false);
    assert.equal(workerProviders.includes(StaffAuthController), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(MediaObjectStoreCapabilityModule), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(MediaStorageCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledMediaObjectStore), false);
    assert.equal(workerProviders.includes(S3MediaObjectStore), false);
    assert.equal(workerProviders.includes(MEDIA_OBJECT_STORE), false);
    assert.equal(workerProviders.includes(MediaStorageService), false);
    assert.equal(workerProviders.includes(MediaStorageController), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ObjectStorageProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledObjectStorageProvider), false);
    assert.equal(workerProviders.includes(OBJECT_STORAGE_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(KeyManagementProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledKeyManagementProvider), false);
    assert.equal(workerProviders.includes(KEY_MANAGEMENT_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(MalwareScannerProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledMalwareScannerProvider), false);
    assert.equal(workerProviders.includes(MALWARE_SCANNER_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(EmailDeliveryProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledEmailDeliveryProvider), false);
    assert.equal(workerProviders.includes(EMAIL_DELIVERY_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(WebPushDeliveryProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledWebPushDeliveryProvider), false);
    assert.equal(workerProviders.includes(VapidWebPushProvider), false);
    assert.equal(workerProviders.includes(WEB_PUSH_DELIVERY_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(OperationalRuntimeCapabilityModule), false);
    assert.ok(workerProviders.includes(TelemetryRepository));
    assert.ok(workerProviders.includes(TelemetryService));
    assert.ok(workerProviders.includes(AdminWorkerRuntimeSink));
    assert.equal(((worker.imports ?? []) as unknown[]).includes(LegalConsentsCapabilityModule), false);
    assert.ok(workerProviders.includes(LegalConsentService));
    assert.ok(workerProviders.includes(DatabaseLegalDocumentProvider));
    assert.ok(workerProviders.includes(LEGAL_DOCUMENT_PROVIDER));
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ContentReleasesCapabilityModule), false);
    assert.equal(workerProviders.includes(ContentReleasesService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(CookingCapabilityModule), false);
    assert.ok(workerProviders.includes(CookingLifecycleService));
    assert.equal(workerProviders.includes(CookingService), false);
    assert.equal(workerProviders.includes(CookingStatisticsPolicy), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ShoppingCapabilityModule), false);
    assert.equal(workerProviders.includes(ShoppingService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(SearchCapabilityModule), false);
    assert.equal(workerProviders.includes(SearchService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ProAccessCapabilityModule), false);
    assert.ok(workerProviders.includes(ProAccessService));
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ReceiptsCapabilityModule), false);
    assert.equal(workerProviders.includes(ReceiptsService), false);
    assert.equal(workerProviders.includes(PurchasesService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(DiaryCapabilityModule), false);
    assert.ok(workerProviders.includes(DiaryService));
    assert.equal(((worker.imports ?? []) as unknown[]).includes(MealPlanCapabilityModule), false);
    assert.equal(workerProviders.includes(MealPlanService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(PrivacyCapabilityModule), false);
    assert.equal(workerProviders.includes(PrivacyService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(SupportCapabilityModule), false);
    assert.equal(workerProviders.includes(SupportService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(CommunityCapabilityModule), false);
    assert.equal(workerProviders.includes(CommunityService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AiAppealsCapabilityModule), false);
    assert.equal(workerProviders.includes(AiAppealsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminSupportCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminSupportService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(HealthCapabilityModule), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminNotificationsCapabilityModule), false);
    assert.equal(workerProviders.includes(NotificationCenterService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminActionsCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminActionsService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(ProfilesCapabilityModule), false);
    assert.equal(workerProviders.includes(ProfilesService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(AdminFreeAiCapabilityModule), false);
    assert.equal(workerProviders.includes(AdminFreeAiService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(FamilyNotesCapabilityModule), false);
    assert.equal(workerProviders.includes(FamilyNotesService), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(OcrCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledOcrProvider), false);
    assert.equal(workerProviders.includes(OCR_PROVIDER), false);
    assert.equal(((worker.imports ?? []) as unknown[]).includes(SecretProviderCapabilityModule), false);
    assert.equal(workerProviders.includes(DisabledSecretProvider), false);
    assert.equal(workerProviders.includes(SECRET_PROVIDER), false);
});
