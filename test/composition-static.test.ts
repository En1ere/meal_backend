import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { DynamicModule, Provider } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../src/app/app.module.js';
import { readConfig } from '../src/app/config.js';
import { CoreRuntimeModule } from '../src/app/core-runtime.module.js';
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
import { CatalogRecipesModule } from '../src/contexts/catalog-recipes/catalog-recipes.module.js';
import { CookingCapabilityModule } from '../src/contexts/catalog-recipes/cooking-capability.module.js';
import { AllergenIntelligenceCapabilityModule } from '../src/contexts/catalog-recipes/allergen-intelligence-capability.module.js';
import { ProductsCapabilityModule } from '../src/contexts/catalog-recipes/products-capability.module.js';
import { PreservesCapabilityModule } from '../src/contexts/catalog-recipes/preserves-capability.module.js';
import { RecipesCapabilityModule } from '../src/contexts/catalog-recipes/recipes-capability.module.js';
import { SearchCapabilityModule } from '../src/contexts/catalog-recipes/search-capability.module.js';
import { RecipeWorkspaceCapabilityModule } from '../src/contexts/catalog-recipes/recipe-workspace-capability.module.js';
import { EntitlementsCapabilityModule } from '../src/contexts/household-entitlements/entitlements-capability.module.js';
import { ProAccessCapabilityModule } from '../src/contexts/household-entitlements/pro-access-capability.module.js';
import { ProOverviewCapabilityModule } from '../src/contexts/household-entitlements/pro-overview-capability.module.js';
import { FamilyNotesCapabilityModule } from '../src/contexts/household-entitlements/family-notes-capability.module.js';
import { FamilyChatCapabilityModule } from '../src/contexts/household-entitlements/family-chat-capability.module.js';
import { SubscriptionSettingsCapabilityModule } from '../src/contexts/household-entitlements/subscription-settings-capability.module.js';
import { FamilyCapabilityModule } from '../src/contexts/household-entitlements/family-capability.module.js';
import { InventoryCapabilityModule } from '../src/contexts/inventory-commerce/inventory-capability.module.js';
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
import { RecommendationsCapabilityModule } from '../src/contexts/planning-health/recommendations-capability.module.js';
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
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import {
    AdminAccessService,
    AdminAuthController,
    AdminReadBoundary,
    AdminSessionGuard,
} from '../src/modules/admin-auth/public.js';
import {
    AdminObservabilityController,
    AdminObservabilityRepository,
    AdminObservabilityService,
    HostSnapshotReader,
} from '../src/modules/admin-observability/public.js';
import {
    AdminAllergensController,
    AllergenIntelligenceService,
    AllergenReportController,
} from '../src/modules/allergen-intelligence/public.js';
import { AuthCookies, AuthService, UserSessionGuard } from './composition-auth.fixture.js';
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
import { HealthController } from '../src/modules/health/public.js';
import {
    AI_V2_PROVIDER_PORT,
    AI_V2_PROVIDER_RUNTIME,
    AiController,
    AiProvider,
    AiProviderSimulator,
    AiReconciliationService,
    AiService,
    AiV2CulinaryExecutor,
    AiV2CulinaryInternalService,
    AiV2SubstitutionExecutor,
    AiV2SubstitutionInternalService,
    AiV2PublicActivationGate,
    AiV2ProviderOperationStore,
} from '../src/modules/ai/public.js';
import { AiAppealsController, AiAppealsService } from '../src/modules/ai-appeals/public.js';
import {
    ACCOUNT_MAIL_OUTBOX,
    AccountController,
    AccountService,
    DisabledAccountMailOutbox,
    MailboxController,
    PostgresAccountMailOutbox,
    RegistrationRiskPolicy,
} from '../src/modules/account/public.js';
import {
    AccountLifecycleController,
    AccountLifecycleService,
    AdminAccountLifecycleController,
    CriticalReauthService,
} from '../src/modules/account-lifecycle/public.js';
import { AdminContentController, AdminContentService } from '../src/modules/admin-content/public.js';
import { AdminReadController, AdminReadService } from '../src/modules/admin/public.js';
import {
    AdminRuntimeSettingsController,
    AdminRuntimeSettingsService,
    LocalBackupStatusReader,
} from '../src/modules/admin-runtime-settings/public.js';
import { AdminActionsController, AdminActionsService } from '../src/modules/admin-actions/public.js';
import {
    OperationalMaintenanceService,
    OperationsWorkspaceController,
    OperationsWorkspaceService,
} from '../src/modules/admin-operations/public.js';
import { AdminGovernanceController, AdminGovernanceService } from '../src/modules/admin-governance/public.js';
import { AdminFreeAiController, AdminFreeAiService } from '../src/modules/admin-free-ai/public.js';
import {
    AdminAcceptanceTestsController,
    AdminAcceptanceTestsRepository,
    AdminAcceptanceTestsService,
} from '../src/modules/admin-acceptance-tests/public.js';
import { DisabledOcrProvider, OCR_PROVIDER } from '../src/modules/ocr-infrastructure/public.js';
import { NotificationCenterController, NotificationCenterService } from '../src/modules/admin-notifications/public.js';
import { AdminSupportController, AdminSupportService } from '../src/modules/admin-support/public.js';
import {
    AdminNewsController,
    AdminNewsService,
    NewsPublicController,
    NewsPublicService,
    ScheduledNewsRunner,
} from '../src/modules/admin-news/public.js';
import { AdminBillingController, AdminBillingService } from '../src/modules/admin-billing/public.js';
import {
    AdminReviewController,
    AdminReviewService,
    AdminRollbackRegistry,
} from '../src/modules/admin-review/public.js';
import {
    CookingController,
    CookingLifecycleService,
    CookingService,
    CookingStatisticsController,
    CookingStatisticsPolicy,
} from '../src/modules/cooking/public.js';
import {
    AchievementsController,
    ContentReleasesController,
    ContentReleasesService,
} from '../src/modules/content-releases/public.js';
import { CommunityController, CommunityService } from '../src/modules/community/public.js';
import { EntitlementsController, EntitlementsService } from '../src/modules/entitlements/public.js';
import { FamilyNotesController, FamilyNotesService } from '../src/modules/family-notes/public.js';
import { FamilyChatController, FamilyChatService } from '../src/modules/family-chat/public.js';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
    LegalConsentController,
    LegalConsentGuard,
    LegalConsentService,
    PublicLegalController,
} from '../src/modules/legal-consents/public.js';
import { InventoryController, InventoryService } from '../src/modules/inventory/public.js';
import { InventoryIngestController, InventoryIngestService } from '../src/modules/inventory-ingest/public.js';
import { ModeratorController, ModeratorService, ModeratorSessionGuard } from '../src/modules/moderator/public.js';
import { ProductsController, ProductsService } from '../src/modules/products/public.js';
import { PersonalizationController, PersonalizationService } from '../src/modules/personalization/public.js';
import { PreservesController, PreservesService } from '../src/modules/preserves/public.js';
import { PrivacyController, PrivacyService } from '../src/modules/privacy/public.js';
import { RecommendationsController, RecommendationsService } from '../src/modules/recommendations/public.js';
import { RecipeLifecycleService } from '../src/modules/recipe-lifecycle/public.js';
import { RecipePolicyController, RecipePolicyService } from '../src/modules/recipe-policy/public.js';
import { RecipeWorkspaceController, RecipeWorkspaceService } from '../src/modules/recipe-workspace/public.js';
import { RecipesController, RecipesService } from '../src/modules/recipes/public.js';
import { ShoppingController, ShoppingService } from '../src/modules/shopping/public.js';
import { SearchController, SearchService } from '../src/modules/search/public.js';
import { SupportController, SupportService } from '../src/modules/support/public.js';
import { DiaryController, DiaryService } from '../src/modules/diary/public.js';
import { ExportsController, ExportsService } from '../src/modules/exports/public.js';
import { FinanceController, FinanceService, PricingController, PricingService } from '../src/modules/finance/public.js';
import {
    SubscriptionSettingsController,
    SubscriptionSettingsService,
} from '../src/modules/subscription-settings/public.js';
import { FamilyController, FamilyService } from '../src/modules/family/public.js';
import { MealPlanController, MealPlanService, PortionsController } from '../src/modules/meal-plan/public.js';
import { NutritionController, NutritionService } from '../src/modules/nutrition/public.js';
import {
    NotificationsController,
    NotificationsService,
    WebPushSubscriptionsController,
    WebPushSubscriptionsService,
} from '../src/modules/notifications/public.js';
import { ProfilesController, ProfilesService } from '../src/modules/profiles/public.js';
import { ProAccessService, ProOverviewController, ProOverviewService } from '../src/modules/pro-overview/public.js';
import {
    DisabledPaymentProvider,
    DisabledRefundProvider,
    PAYMENT_PROVIDER,
    PAYMENT_REPOSITORY,
    PaymentApplicationService,
    PostgresPaymentRepository,
    REFUND_PROVIDER,
} from '../src/modules/payments/public.js';
import {
    PurchasesController,
    PurchasesService,
    ReceiptsController,
    ReceiptsService,
} from '../src/modules/receipts/public.js';
import {
    AdminProviderTelemetry,
    AdminWorkerRuntimeSink,
    TelemetryController,
    TelemetryRepository,
    TelemetryService,
} from '../src/modules/telemetry/public.js';
import {
    DisabledSecretProvider,
    PROVIDER_TELEMETRY,
    ProviderObserver,
    SECRET_PROVIDER,
} from '../src/modules/provider-runtime/public.js';
import { WorkerRuntimeFactory } from '../src/infrastructure/workers/worker-runtime.factory.js';
import { APP_CONFIG } from '../src/shared/config/app-config.js';

const config = readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const providerToken = (provider: Provider): unknown =>
    typeof provider === 'object' && provider !== null && 'provide' in provider ? provider.provide : provider;

void test('root composition delegates pilot and core providers without duplicate ownership', () => {
    const root = AppModule.configure(config);
    const rootProviders = (root.providers ?? []).map(providerToken);
    const rootControllers = root.controllers ?? [];
    for (const provider of [
        DatabaseService,
        AuthService,
        AdminAccessService,
        AuthCookies,
        UserSessionGuard,
        AdminSessionGuard,
        RecipePolicyService,
        RecipeLifecycleService,
        EntitlementsService,
        InventoryService,
        ProductsService,
        RecommendationsService,
        AllergenIntelligenceService,
        RecipesService,
        PreservesService,
        TelemetryRepository,
        TelemetryService,
        AdminProviderTelemetry,
        AdminWorkerRuntimeSink,
        PROVIDER_TELEMETRY,
        WorkerRuntimeFactory,
        LegalConsentService,
        LegalConsentGuard,
        DatabaseLegalDocumentProvider,
        LEGAL_DOCUMENT_PROVIDER,
        ContentReleasesService,
        CookingService,
        CookingLifecycleService,
        CookingStatisticsPolicy,
        ShoppingService,
        SearchService,
        ProAccessService,
        ReceiptsService,
        PurchasesService,
        DiaryService,
        MealPlanService,
        PrivacyService,
        SupportService,
        CommunityService,
        AiAppealsService,
        AdminSupportService,
        NotificationCenterService,
        AdminActionsService,
        ProfilesService,
        AdminFreeAiService,
        FamilyNotesService,
        DisabledOcrProvider,
        OCR_PROVIDER,
        DisabledSecretProvider,
        SECRET_PROVIDER,
        ProviderObserver,
        PersonalizationService,
        FamilyChatService,
        NutritionService,
        InventoryIngestService,
        OperationsWorkspaceService,
        OperationalMaintenanceService,
        CriticalReauthService,
        ExportsService,
        AdminGovernanceService,
        AccountLifecycleService,
        RecipeWorkspaceService,
        AdminAcceptanceTestsRepository,
        AdminAcceptanceTestsService,
        NotificationsService,
        WebPushSubscriptionsService,
        AdminReadBoundary,
        AdminObservabilityRepository,
        AdminObservabilityService,
        HostSnapshotReader,
        AdminContentService,
        AdminReadService,
        AdminRuntimeSettingsService,
        LocalBackupStatusReader,
        AdminReviewService,
        AdminRollbackRegistry,
        StaffSessionGuard,
        STAFF_SESSION_GUARD,
        StaffSessionRouteGuard,
        ModeratorService,
        ModeratorSessionGuard,
        PricingService,
        FinanceService,
        SubscriptionSettingsService,
        FamilyService,
        AiProvider,
        AiService,
        AiReconciliationService,
        AiV2ProviderOperationStore,
        ProOverviewService,
        DisabledPaymentProvider,
        PAYMENT_PROVIDER,
        DisabledRefundProvider,
        REFUND_PROVIDER,
        PostgresPaymentRepository,
        PAYMENT_REPOSITORY,
        PaymentApplicationService,
        AdminBillingService,
        AdminNewsService,
        ScheduledNewsRunner,
        NewsPublicService,
        RegistrationRiskPolicy,
        DisabledAccountMailOutbox,
        PostgresAccountMailOutbox,
        ACCOUNT_MAIL_OUTBOX,
        AccountService,
        DisabledMediaObjectStore,
        S3MediaObjectStore,
        MEDIA_OBJECT_STORE,
        MediaStorageService,
        DisabledObjectStorageProvider,
        OBJECT_STORAGE_PROVIDER,
        DisabledKeyManagementProvider,
        KEY_MANAGEMENT_PROVIDER,
        DisabledMalwareScannerProvider,
        MALWARE_SCANNER_PROVIDER,
        DisabledEmailDeliveryProvider,
        EMAIL_DELIVERY_PROVIDER,
        DisabledWebPushDeliveryProvider,
        VapidWebPushProvider,
        WEB_PUSH_DELIVERY_PROVIDER,
    ])
        assert.equal(
            rootProviders.includes(provider),
            false,
            typeof provider === 'function' ? provider.name : String(provider),
        );
    assert.equal(rootControllers.includes(RecipePolicyController), false);
    assert.equal(rootControllers.includes(AccountController), false);
    assert.equal(rootControllers.includes(MailboxController), false);
    assert.equal(rootControllers.includes(AuthController), false);
    assert.equal(rootControllers.includes(StaffAuthController), false);
    assert.equal(rootControllers.includes(MediaStorageController), false);
    assert.equal(rootControllers.includes(EntitlementsController), false);
    assert.equal(rootControllers.includes(InventoryController), false);
    assert.equal(rootControllers.includes(ProductsController), false);
    assert.equal(rootControllers.includes(RecommendationsController), false);
    assert.equal(rootControllers.includes(AdminAllergensController), false);
    assert.equal(rootControllers.includes(AllergenReportController), false);
    assert.equal(rootControllers.includes(RecipesController), false);
    assert.equal(rootControllers.includes(PreservesController), false);
    assert.equal(rootControllers.includes(TelemetryController), false);
    assert.equal(rootControllers.includes(PublicLegalController), false);
    assert.equal(rootControllers.includes(LegalConsentController), false);
    assert.equal(rootControllers.includes(ContentReleasesController), false);
    assert.equal(rootControllers.includes(AchievementsController), false);
    assert.equal(rootControllers.includes(CookingController), false);
    assert.equal(rootControllers.includes(CookingStatisticsController), false);
    assert.equal(rootControllers.includes(ShoppingController), false);
    assert.equal(rootControllers.includes(SearchController), false);
    assert.equal(rootControllers.includes(ReceiptsController), false);
    assert.equal(rootControllers.includes(PurchasesController), false);
    assert.equal(rootControllers.includes(DiaryController), false);
    assert.equal(rootControllers.includes(MealPlanController), false);
    assert.equal(rootControllers.includes(PortionsController), false);
    assert.equal(rootControllers.includes(PrivacyController), false);
    assert.equal(rootControllers.includes(SupportController), false);
    assert.equal(rootControllers.includes(CommunityController), false);
    assert.equal(rootControllers.includes(AiAppealsController), false);
    assert.equal(rootControllers.includes(AdminSupportController), false);
    assert.equal(rootControllers.includes(HealthController), false);
    assert.equal(rootControllers.includes(NotificationCenterController), false);
    assert.equal(rootControllers.includes(AdminActionsController), false);
    assert.equal(rootControllers.includes(ProfilesController), false);
    assert.equal(rootControllers.includes(AdminFreeAiController), false);
    assert.equal(rootControllers.includes(FamilyNotesController), false);
    assert.equal(rootControllers.includes(PersonalizationController), false);
    assert.equal(rootControllers.includes(FamilyChatController), false);
    assert.equal(rootControllers.includes(NutritionController), false);
    assert.equal(rootControllers.includes(InventoryIngestController), false);
    assert.equal(rootControllers.includes(ExportsController), false);
    assert.equal(rootControllers.includes(OperationsWorkspaceController), false);
    assert.equal(rootControllers.includes(AdminGovernanceController), false);
    assert.equal(rootControllers.includes(AccountLifecycleController), false);
    assert.equal(rootControllers.includes(AdminAccountLifecycleController), false);
    assert.equal(rootControllers.includes(RecipeWorkspaceController), false);
    assert.equal(rootControllers.includes(AdminAuthController), false);
    assert.equal(rootControllers.includes(AdminAcceptanceTestsController), false);
    assert.equal(rootControllers.includes(NotificationsController), false);
    assert.equal(rootControllers.includes(WebPushSubscriptionsController), false);
    assert.equal(rootControllers.includes(AdminObservabilityController), false);
    assert.equal(rootControllers.includes(AdminContentController), false);
    assert.equal(rootControllers.includes(AdminReadController), false);
    assert.equal(rootControllers.includes(AdminRuntimeSettingsController), false);
    assert.equal(rootControllers.includes(AdminReviewController), false);
    assert.equal(rootControllers.includes(ModeratorController), false);
    assert.equal(rootControllers.includes(PricingController), false);
    assert.equal(rootControllers.includes(FinanceController), false);
    assert.equal(rootControllers.includes(SubscriptionSettingsController), false);
    assert.equal(rootControllers.includes(FamilyController), false);
    assert.equal(rootControllers.includes(AiController), false);
    assert.equal(rootControllers.includes(ProOverviewController), false);
    assert.equal(rootControllers.includes(AdminBillingController), false);
    assert.equal(rootControllers.includes(AdminNewsController), false);
    assert.equal(rootControllers.includes(NewsPublicController), false);

    const imports = (root.imports ?? []) as ReadonlyArray<unknown>;
    const core = imports.find(
        (entry): entry is DynamicModule =>
            typeof entry === 'object' && entry !== null && 'module' in entry && entry.module === CoreRuntimeModule,
    );
    assert.ok(core);
    assert.ok(imports.includes(CatalogRecipesModule));
    assert.ok(imports.includes(EntitlementsCapabilityModule));
    assert.ok(imports.includes(InventoryCapabilityModule));
    assert.ok(imports.includes(ProductsCapabilityModule));
    assert.ok(imports.includes(RecommendationsCapabilityModule));
    assert.ok(imports.includes(AllergenIntelligenceCapabilityModule));
    assert.ok(imports.includes(RecipesCapabilityModule));
    assert.ok(imports.includes(PreservesCapabilityModule));
    assert.ok(imports.includes(TelemetryCapabilityModule));
    assert.ok(imports.includes(OperationalRuntimeCapabilityModule));
    assert.ok(imports.includes(LegalConsentsCapabilityModule));
    assert.ok(imports.includes(ContentReleasesCapabilityModule));
    assert.ok(imports.includes(CookingCapabilityModule));
    assert.ok(imports.includes(ShoppingCapabilityModule));
    assert.ok(imports.includes(SearchCapabilityModule));
    assert.equal(imports.includes(ProAccessCapabilityModule), false);
    assert.ok(imports.includes(ReceiptsCapabilityModule));
    assert.ok(imports.includes(DiaryCapabilityModule));
    assert.ok(imports.includes(MealPlanCapabilityModule));
    assert.ok(imports.includes(PrivacyCapabilityModule));
    assert.ok(imports.includes(SupportCapabilityModule));
    assert.ok(imports.includes(CommunityCapabilityModule));
    assert.ok(imports.includes(AiAppealsCapabilityModule));
    assert.ok(imports.includes(AdminSupportCapabilityModule));
    assert.ok(imports.includes(HealthCapabilityModule));
    assert.ok(imports.includes(AdminNotificationsCapabilityModule));
    assert.ok(imports.includes(AdminActionsCapabilityModule));
    assert.ok(imports.includes(ProfilesCapabilityModule));
    assert.ok(imports.includes(AdminFreeAiCapabilityModule));
    assert.ok(imports.includes(FamilyNotesCapabilityModule));
    assert.ok(imports.includes(OcrCapabilityModule));
    assert.ok(imports.includes(SecretProviderCapabilityModule));
    assert.ok(imports.includes(ProviderObservationCapabilityModule));
    assert.ok(imports.includes(PersonalizationCapabilityModule));
    assert.ok(imports.includes(FamilyChatCapabilityModule));
    assert.ok(imports.includes(NutritionCapabilityModule));
    assert.ok(imports.includes(InventoryIngestCapabilityModule));
    assert.ok(imports.includes(AdminOperationsCapabilityModule));
    assert.ok(imports.includes(CriticalReauthCapabilityModule));
    assert.ok(imports.includes(ExportsCapabilityModule));
    assert.ok(imports.includes(AdminGovernanceCapabilityModule));
    assert.ok(imports.includes(AccountLifecycleCapabilityModule));
    assert.ok(imports.includes(RecipeWorkspaceCapabilityModule));
    assert.ok(imports.includes(AdminAuthCapabilityModule));
    assert.ok(imports.includes(AdminAcceptanceTestsCapabilityModule));
    assert.ok(imports.includes(NotificationsCapabilityModule));
    assert.ok(imports.includes(AdminReadBoundaryCapabilityModule));
    assert.ok(imports.includes(AdminObservabilityCapabilityModule));
    assert.ok(imports.includes(AdminContentCapabilityModule));
    assert.ok(imports.includes(AdminReadCapabilityModule));
    assert.ok(imports.includes(AdminRuntimeSettingsCapabilityModule));
    assert.ok(imports.includes(AdminReviewCapabilityModule));
    assert.ok(imports.includes(ModeratorCapabilityModule));
    assert.ok(imports.includes(PricingCapabilityModule));
    assert.ok(imports.includes(FinanceCapabilityModule));
    assert.ok(imports.includes(SubscriptionSettingsCapabilityModule));
    assert.ok(imports.includes(FamilyCapabilityModule));
    assert.equal(imports.includes(AiProviderCapabilityModule), false);
    assert.ok(imports.includes(AiCapabilityModule));
    assert.ok(imports.includes(ProOverviewCapabilityModule));
    assert.ok(imports.includes(AdminBillingCapabilityModule));
    assert.ok(imports.includes(AdminNewsCapabilityModule));
    assert.ok(imports.includes(RegistrationRiskCapabilityModule));
    assert.ok(imports.includes(AccountMailOutboxCapabilityModule));
    assert.ok(imports.includes(AccountServiceCapabilityModule));
    assert.ok(imports.includes(AccountHttpCapabilityModule));
    assert.ok(imports.includes(UserAuthHttpCapabilityModule));
    assert.ok(imports.includes(StaffAuthHttpCapabilityModule));
    assert.equal(imports.includes(MediaObjectStoreCapabilityModule), false);
    assert.ok(imports.includes(MediaStorageCapabilityModule));
    assert.ok(imports.includes(ObjectStorageProviderCapabilityModule));
    assert.ok(imports.includes(KeyManagementProviderCapabilityModule));
    assert.ok(imports.includes(MalwareScannerProviderCapabilityModule));
    assert.ok(imports.includes(EmailDeliveryProviderCapabilityModule));
    assert.ok(imports.includes(WebPushDeliveryProviderCapabilityModule));
    assert.equal(imports.includes(PaymentApplicationCapabilityModule), false);
    assert.equal(imports.includes(PaymentProviderCapabilityModule), false);
    assert.equal(imports.includes(RefundProviderCapabilityModule), false);
    assert.equal(imports.includes(PaymentRepositoryCapabilityModule), false);
    const inventoryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryCapabilityModule) ??
        []) as unknown[];
    const inventoryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, InventoryCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(inventoryImports, [EntitlementsCapabilityModule]);
    assert.equal(inventoryExports.includes(InventoryService), false);
    const productsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProductsCapabilityModule) ?? []) as unknown[];
    const productsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProductsCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(productsImports, []);
    assert.equal(productsExports.includes(ProductsService), false);
    const recommendationImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RecommendationsCapabilityModule) ??
        []) as unknown[];
    const recommendationExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, RecommendationsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(recommendationImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(recommendationExports, [RecommendationsService]);
    const allergenImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AllergenIntelligenceCapabilityModule) ??
        []) as unknown[];
    const allergenExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AllergenIntelligenceCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(allergenImports, []);
    assert.deepEqual(allergenExports, [AllergenIntelligenceService]);
    const recipesImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RecipesCapabilityModule) ?? []) as unknown[];
    const recipesExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, RecipesCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(recipesImports, [
        EntitlementsCapabilityModule,
        RecommendationsCapabilityModule,
        AllergenIntelligenceCapabilityModule,
    ]);
    assert.deepEqual(recipesExports, [RecipesService]);
    const preservesImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PreservesCapabilityModule) ??
        []) as unknown[];
    const preservesExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PreservesCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(preservesImports, [EntitlementsCapabilityModule]);
    assert.equal(preservesImports.includes(InventoryCapabilityModule), false);
    assert.equal(preservesExports.includes(PreservesService), false);
    const telemetryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, TelemetryCapabilityModule) ??
        []) as unknown[];
    const telemetryProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TelemetryCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const telemetryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, TelemetryCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(telemetryImports, []);
    assert.deepEqual(telemetryProviders, [
        TelemetryRepository,
        TelemetryService,
        AdminProviderTelemetry,
        AdminWorkerRuntimeSink,
        PROVIDER_TELEMETRY,
    ]);
    assert.deepEqual(telemetryExports, [TelemetryService, AdminWorkerRuntimeSink, PROVIDER_TELEMETRY]);
    const operationalImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, OperationalRuntimeCapabilityModule) ??
        []) as unknown[];
    const operationalProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, OperationalRuntimeCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const operationalExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, OperationalRuntimeCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(operationalImports, [TelemetryCapabilityModule]);
    assert.deepEqual(operationalProviders, [WorkerRuntimeFactory]);
    assert.deepEqual(operationalExports, [WorkerRuntimeFactory]);
    assert.equal((operationalProviders as unknown[]).includes(AdminWorkerRuntimeSink), false);
    const legalImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, LegalConsentsCapabilityModule) ??
        []) as unknown[];
    const legalControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, LegalConsentsCapabilityModule) ??
        []) as unknown[];
    const legalProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LegalConsentsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const legalExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, LegalConsentsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(legalImports, []);
    assert.deepEqual(legalControllers, [PublicLegalController, LegalConsentController]);
    assert.deepEqual(legalProviders, [
        LegalConsentService,
        LegalConsentGuard,
        DatabaseLegalDocumentProvider,
        LEGAL_DOCUMENT_PROVIDER,
    ]);
    assert.deepEqual(legalExports, [LegalConsentService]);
    const releasesImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ContentReleasesCapabilityModule) ??
        []) as unknown[];
    const releasesControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ContentReleasesCapabilityModule) ??
        []) as unknown[];
    const releasesProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ContentReleasesCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const releasesExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ContentReleasesCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(releasesImports, [LegalConsentsCapabilityModule]);
    assert.deepEqual(releasesControllers, [ContentReleasesController, AchievementsController]);
    assert.deepEqual(releasesProviders, [ContentReleasesService]);
    assert.deepEqual(releasesExports, [ContentReleasesService]);
    const cookingImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, CookingCapabilityModule) ?? []) as unknown[];
    const cookingControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CookingCapabilityModule) ??
        []) as unknown[];
    const cookingProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CookingCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const cookingExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, CookingCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(cookingImports, [
        RecipesCapabilityModule,
        OperationalRuntimeCapabilityModule,
        ContentReleasesCapabilityModule,
    ]);
    assert.deepEqual(cookingControllers, [CookingController, CookingStatisticsController]);
    assert.deepEqual(cookingProviders, [CookingService, CookingLifecycleService, CookingStatisticsPolicy]);
    assert.deepEqual(cookingExports, []);
    assert.equal(cookingImports.includes(InventoryCapabilityModule), false);
    assert.equal(cookingImports.includes(PreservesCapabilityModule), false);
    const shoppingImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ShoppingCapabilityModule) ?? []) as unknown[];
    const shoppingControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ShoppingCapabilityModule) ??
        []) as unknown[];
    const shoppingProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ShoppingCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const shoppingExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ShoppingCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(shoppingImports, [RecipesCapabilityModule, EntitlementsCapabilityModule]);
    assert.deepEqual(shoppingControllers, [ShoppingController]);
    assert.deepEqual(shoppingProviders, [ShoppingService]);
    assert.deepEqual(shoppingExports, []);
    assert.equal(shoppingImports.includes(InventoryCapabilityModule), false);
    assert.equal(shoppingImports.includes(CookingCapabilityModule), false);
    const searchImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SearchCapabilityModule) ?? []) as unknown[];
    const searchControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SearchCapabilityModule) ??
        []) as unknown[];
    const searchProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SearchCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const searchExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SearchCapabilityModule) ?? []) as unknown[];
    assert.equal(searchImports.includes(RecipesCapabilityModule), false);
    assert.deepEqual(searchImports, []);
    assert.deepEqual(searchControllers, [SearchController]);
    assert.deepEqual(searchProviders, [SearchService]);
    assert.deepEqual(searchExports, []);
    const proAccessImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProAccessCapabilityModule) ??
        []) as unknown[];
    const proAccessControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProAccessCapabilityModule) ??
        []) as unknown[];
    const proAccessProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProAccessCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const proAccessExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProAccessCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(proAccessImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(proAccessControllers, []);
    assert.deepEqual(proAccessProviders, [ProAccessService]);
    assert.deepEqual(proAccessExports, [ProAccessService]);
    const receiptsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ReceiptsCapabilityModule) ?? []) as unknown[];
    const receiptsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReceiptsCapabilityModule) ??
        []) as unknown[];
    const receiptsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReceiptsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const receiptsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ReceiptsCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(receiptsImports, [EntitlementsCapabilityModule, ProAccessCapabilityModule]);
    assert.deepEqual(receiptsControllers, [ReceiptsController, PurchasesController]);
    assert.deepEqual(receiptsProviders, [ReceiptsService, PurchasesService]);
    assert.deepEqual(receiptsExports, []);
    assert.equal(receiptsImports.includes(InventoryCapabilityModule), false);
    assert.equal(receiptsImports.includes(ShoppingCapabilityModule), false);
    assert.equal(receiptsImports.includes(CookingCapabilityModule), false);
    const diaryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, DiaryCapabilityModule) ?? []) as unknown[];
    const diaryControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DiaryCapabilityModule) ??
        []) as unknown[];
    const diaryProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DiaryCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const diaryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, DiaryCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(diaryImports, [ProAccessCapabilityModule, LegalConsentsCapabilityModule]);
    assert.deepEqual(diaryControllers, [DiaryController]);
    assert.deepEqual(diaryProviders, [DiaryService]);
    assert.deepEqual(diaryExports, [DiaryService]);
    assert.equal(diaryImports.includes(InventoryCapabilityModule), false);
    const mealPlanImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MealPlanCapabilityModule) ?? []) as unknown[];
    const mealPlanControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MealPlanCapabilityModule) ??
        []) as unknown[];
    const mealPlanProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MealPlanCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const mealPlanExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, MealPlanCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(mealPlanImports, [EntitlementsCapabilityModule, DiaryCapabilityModule]);
    assert.deepEqual(mealPlanControllers, [MealPlanController, PortionsController]);
    assert.deepEqual(mealPlanProviders, [MealPlanService]);
    assert.deepEqual(mealPlanExports, [MealPlanService]);
    assert.equal(mealPlanImports.includes(RecipesCapabilityModule), false);
    assert.equal(mealPlanImports.includes(InventoryCapabilityModule), false);
    assert.equal(mealPlanImports.includes(RecommendationsCapabilityModule), false);
    const privacyImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PrivacyCapabilityModule) ?? []) as unknown[];
    const privacyControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PrivacyCapabilityModule) ??
        []) as unknown[];
    const privacyProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PrivacyCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const privacyExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PrivacyCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(privacyImports, []);
    assert.deepEqual(privacyControllers, [PrivacyController]);
    assert.deepEqual(privacyProviders, [PrivacyService]);
    assert.deepEqual(privacyExports, []);
    const supportImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SupportCapabilityModule) ?? []) as unknown[];
    const supportControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SupportCapabilityModule) ??
        []) as unknown[];
    const supportProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SupportCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const supportExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SupportCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(supportImports, []);
    assert.deepEqual(supportControllers, [SupportController]);
    assert.deepEqual(supportProviders, [SupportService]);
    assert.deepEqual(supportExports, []);
    const communityImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, CommunityCapabilityModule) ??
        []) as unknown[];
    const communityControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CommunityCapabilityModule) ??
        []) as unknown[];
    const communityProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CommunityCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const communityExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, CommunityCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(communityImports, []);
    assert.deepEqual(communityControllers, [CommunityController]);
    assert.deepEqual(communityProviders, [CommunityService]);
    assert.deepEqual(communityExports, []);
    const aiAppealsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AiAppealsCapabilityModule) ??
        []) as unknown[];
    const aiAppealsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiAppealsCapabilityModule) ??
        []) as unknown[];
    const aiAppealsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AiAppealsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const aiAppealsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AiAppealsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(aiAppealsImports, []);
    assert.deepEqual(aiAppealsControllers, [AiAppealsController]);
    assert.deepEqual(aiAppealsProviders, [AiAppealsService]);
    assert.deepEqual(aiAppealsExports, []);
    const adminSupportImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminSupportCapabilityModule) ??
        []) as unknown[];
    const adminSupportControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminSupportCapabilityModule) ??
        []) as unknown[];
    const adminSupportProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminSupportCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminSupportExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminSupportCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminSupportImports, []);
    assert.deepEqual(adminSupportControllers, [AdminSupportController]);
    assert.deepEqual(adminSupportProviders, [AdminSupportService]);
    assert.deepEqual(adminSupportExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminSupportController), [AdminSessionGuard]);
    const healthImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, HealthCapabilityModule) ?? []) as unknown[];
    const healthControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HealthCapabilityModule) ??
        []) as unknown[];
    const healthProviders = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, HealthCapabilityModule) ?? []) as unknown[];
    const healthExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, HealthCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(healthImports, []);
    assert.deepEqual(healthControllers, [HealthController]);
    assert.deepEqual(healthProviders, []);
    assert.deepEqual(healthExports, []);
    const adminNotificationsImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        AdminNotificationsCapabilityModule,
    ) ?? []) as unknown[];
    const adminNotificationsControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminNotificationsCapabilityModule,
    ) ?? []) as unknown[];
    const adminNotificationsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminNotificationsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminNotificationsExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        AdminNotificationsCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(adminNotificationsImports, []);
    assert.deepEqual(adminNotificationsControllers, [NotificationCenterController]);
    assert.deepEqual(adminNotificationsProviders, [NotificationCenterService]);
    assert.deepEqual(adminNotificationsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, NotificationCenterController), [AdminSessionGuard]);
    const adminActionsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminActionsCapabilityModule) ??
        []) as unknown[];
    const adminActionsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminActionsCapabilityModule) ??
        []) as unknown[];
    const adminActionsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminActionsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminActionsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminActionsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminActionsImports, []);
    assert.deepEqual(adminActionsControllers, [AdminActionsController]);
    assert.deepEqual(adminActionsProviders, [AdminActionsService]);
    assert.deepEqual(adminActionsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminActionsController), [AdminSessionGuard]);
    const profilesImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProfilesCapabilityModule) ?? []) as unknown[];
    const profilesControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProfilesCapabilityModule) ??
        []) as unknown[];
    const profilesProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProfilesCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const profilesExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProfilesCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(profilesImports, [LegalConsentsCapabilityModule]);
    assert.deepEqual(profilesControllers, [ProfilesController]);
    assert.deepEqual(profilesProviders, [ProfilesService]);
    assert.deepEqual(profilesExports, []);
    const profileMethods = ProfilesController.prototype as unknown as Record<string, object>;
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, profileMethods['own']!), [UserSessionGuard]);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, profileMethods['update']!), [UserSessionGuard]);
    assert.equal(Reflect.getMetadata(GUARDS_METADATA, profileMethods['public']!), undefined);
    const adminFreeAiImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminFreeAiCapabilityModule) ??
        []) as unknown[];
    const adminFreeAiControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminFreeAiCapabilityModule) ??
        []) as unknown[];
    const adminFreeAiProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminFreeAiCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminFreeAiExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminFreeAiCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminFreeAiImports, []);
    assert.deepEqual(adminFreeAiControllers, [AdminFreeAiController]);
    assert.deepEqual(adminFreeAiProviders, [AdminFreeAiService]);
    assert.deepEqual(adminFreeAiExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminFreeAiController), [AdminSessionGuard]);
    const familyNotesImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FamilyNotesCapabilityModule) ??
        []) as unknown[];
    const familyNotesControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FamilyNotesCapabilityModule) ??
        []) as unknown[];
    const familyNotesProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FamilyNotesCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const familyNotesExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FamilyNotesCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(familyNotesImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(familyNotesControllers, [FamilyNotesController]);
    assert.deepEqual(familyNotesProviders, [FamilyNotesService]);
    assert.deepEqual(familyNotesExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, FamilyNotesController), [UserSessionGuard]);
    const ocrImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, OcrCapabilityModule) ?? []) as unknown[];
    const ocrControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, OcrCapabilityModule) ?? []) as unknown[];
    const ocrProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, OcrCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const ocrExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, OcrCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(ocrImports, []);
    assert.deepEqual(ocrControllers, []);
    assert.deepEqual(ocrProviders, [DisabledOcrProvider, OCR_PROVIDER]);
    assert.deepEqual(ocrExports, []);
    const secretImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SecretProviderCapabilityModule) ??
        []) as unknown[];
    const secretControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SecretProviderCapabilityModule) ??
        []) as unknown[];
    const secretProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SecretProviderCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const secretExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SecretProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(secretImports, []);
    assert.deepEqual(secretControllers, []);
    assert.deepEqual(secretProviders, [DisabledSecretProvider, SECRET_PROVIDER]);
    assert.deepEqual(secretExports, []);
    const providerObservationImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        ProviderObservationCapabilityModule,
    ) ?? []) as unknown[];
    const providerObservationControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        ProviderObservationCapabilityModule,
    ) ?? []) as unknown[];
    const providerObservationProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProviderObservationCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const providerObservationExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        ProviderObservationCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(providerObservationImports, [TelemetryCapabilityModule]);
    assert.deepEqual(providerObservationControllers, []);
    assert.deepEqual(providerObservationProviders, [ProviderObserver]);
    assert.deepEqual(providerObservationExports, []);
    const personalizationImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PersonalizationCapabilityModule) ??
        []) as unknown[];
    const personalizationControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        PersonalizationCapabilityModule,
    ) ?? []) as unknown[];
    const personalizationProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PersonalizationCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const personalizationExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PersonalizationCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(personalizationImports, [RecommendationsCapabilityModule, LegalConsentsCapabilityModule]);
    assert.deepEqual(personalizationControllers, [PersonalizationController]);
    assert.deepEqual(personalizationProviders, [PersonalizationService]);
    assert.deepEqual(personalizationExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, PersonalizationController), [UserSessionGuard]);
    const familyChatImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FamilyChatCapabilityModule) ??
        []) as unknown[];
    const familyChatControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FamilyChatCapabilityModule) ??
        []) as unknown[];
    const familyChatProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FamilyChatCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const familyChatExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FamilyChatCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(familyChatImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(familyChatControllers, [FamilyChatController]);
    assert.deepEqual(familyChatProviders, [FamilyChatService]);
    assert.deepEqual(familyChatExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, FamilyChatController), [UserSessionGuard]);
    const nutritionImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, NutritionCapabilityModule) ??
        []) as unknown[];
    const nutritionControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, NutritionCapabilityModule) ??
        []) as unknown[];
    const nutritionProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NutritionCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const nutritionExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, NutritionCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(nutritionImports, [ProAccessCapabilityModule, LegalConsentsCapabilityModule]);
    assert.deepEqual(nutritionControllers, [NutritionController]);
    assert.deepEqual(nutritionProviders, [NutritionService]);
    assert.deepEqual(nutritionExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, NutritionController), [UserSessionGuard]);
    const inventoryIngestImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, InventoryIngestCapabilityModule) ??
        []) as unknown[];
    const inventoryIngestControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        InventoryIngestCapabilityModule,
    ) ?? []) as unknown[];
    const inventoryIngestProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InventoryIngestCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const inventoryIngestExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, InventoryIngestCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(inventoryIngestImports, []);
    assert.deepEqual(inventoryIngestControllers, [InventoryIngestController]);
    assert.deepEqual(inventoryIngestProviders, [InventoryIngestService]);
    assert.deepEqual(inventoryIngestExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, InventoryIngestController), [UserSessionGuard]);
    const adminOperationsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminOperationsCapabilityModule) ??
        []) as unknown[];
    const adminOperationsControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminOperationsCapabilityModule,
    ) ?? []) as unknown[];
    const adminOperationsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminOperationsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminOperationsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminOperationsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminOperationsImports, []);
    assert.deepEqual(adminOperationsControllers, [OperationsWorkspaceController]);
    assert.deepEqual(adminOperationsProviders, [OperationsWorkspaceService, OperationalMaintenanceService]);
    assert.deepEqual(adminOperationsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, OperationsWorkspaceController), [AdminSessionGuard]);
    const criticalReauthImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, CriticalReauthCapabilityModule) ??
        []) as unknown[];
    const criticalReauthControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        CriticalReauthCapabilityModule,
    ) ?? []) as unknown[];
    const criticalReauthProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CriticalReauthCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const criticalReauthExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, CriticalReauthCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(criticalReauthImports, []);
    assert.deepEqual(criticalReauthControllers, []);
    assert.deepEqual(criticalReauthProviders, [CriticalReauthService]);
    assert.deepEqual(criticalReauthExports, [CriticalReauthService]);
    const exportsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ExportsCapabilityModule) ?? []) as unknown[];
    const exportsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ExportsCapabilityModule) ??
        []) as unknown[];
    const exportsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ExportsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const exportsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ExportsCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(exportsImports, [CriticalReauthCapabilityModule, ProAccessCapabilityModule]);
    assert.deepEqual(exportsControllers, [ExportsController]);
    assert.deepEqual(exportsProviders, [ExportsService]);
    assert.deepEqual(exportsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ExportsController), [UserSessionGuard]);
    const adminGovernanceImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminGovernanceCapabilityModule) ??
        []) as unknown[];
    const adminGovernanceControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminGovernanceCapabilityModule,
    ) ?? []) as unknown[];
    const adminGovernanceProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminGovernanceCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminGovernanceExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminGovernanceCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminGovernanceImports, []);
    assert.deepEqual(adminGovernanceControllers, [AdminGovernanceController]);
    assert.deepEqual(adminGovernanceProviders, [AdminGovernanceService]);
    assert.deepEqual(adminGovernanceExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminGovernanceController), [AdminSessionGuard]);
    const accountLifecycleImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AccountLifecycleCapabilityModule) ??
        []) as unknown[];
    const accountLifecycleControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AccountLifecycleCapabilityModule,
    ) ?? []) as unknown[];
    const accountLifecycleProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AccountLifecycleCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const accountLifecycleExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AccountLifecycleCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(accountLifecycleImports, [CriticalReauthCapabilityModule]);
    assert.deepEqual(accountLifecycleControllers, [AccountLifecycleController, AdminAccountLifecycleController]);
    assert.deepEqual(accountLifecycleProviders, [AccountLifecycleService]);
    assert.deepEqual(accountLifecycleExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AccountLifecycleController), [UserSessionGuard]);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminAccountLifecycleController), [AdminSessionGuard]);
    const recipeWorkspaceImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RecipeWorkspaceCapabilityModule) ??
        []) as unknown[];
    const recipeWorkspaceControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        RecipeWorkspaceCapabilityModule,
    ) ?? []) as unknown[];
    const recipeWorkspaceProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RecipeWorkspaceCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const recipeWorkspaceExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, RecipeWorkspaceCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(recipeWorkspaceImports, [
        CatalogRecipesModule,
        EntitlementsCapabilityModule,
        LegalConsentsCapabilityModule,
        ContentReleasesCapabilityModule,
    ]);
    assert.deepEqual(recipeWorkspaceControllers, [RecipeWorkspaceController]);
    assert.deepEqual(recipeWorkspaceProviders, [RecipeWorkspaceService]);
    assert.deepEqual(recipeWorkspaceExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RecipeWorkspaceController), [UserSessionGuard]);
    const adminAuthImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminAuthCapabilityModule) ??
        []) as unknown[];
    const adminAuthControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminAuthCapabilityModule) ??
        []) as unknown[];
    const adminAuthProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminAuthCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminAuthExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminAuthCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminAuthImports, []);
    assert.deepEqual(adminAuthControllers, [AdminAuthController]);
    assert.deepEqual(adminAuthProviders, []);
    assert.deepEqual(adminAuthExports, []);
    const adminAuthMethods = AdminAuthController.prototype as unknown as Record<string, object>;
    for (const method of ['confirm', 'me', 'sessions', 'revokeOthers'])
        assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, adminAuthMethods[method]!), [AdminSessionGuard]);
    const adminAcceptanceImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        AdminAcceptanceTestsCapabilityModule,
    ) ?? []) as unknown[];
    const adminAcceptanceControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminAcceptanceTestsCapabilityModule,
    ) ?? []) as unknown[];
    const adminAcceptanceProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminAcceptanceTestsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminAcceptanceExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        AdminAcceptanceTestsCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(adminAcceptanceImports, []);
    assert.deepEqual(adminAcceptanceControllers, [AdminAcceptanceTestsController]);
    assert.deepEqual(adminAcceptanceProviders, [AdminAcceptanceTestsRepository, AdminAcceptanceTestsService]);
    assert.deepEqual(adminAcceptanceExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminAcceptanceTestsController), [AdminSessionGuard]);
    const notificationsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, NotificationsCapabilityModule) ??
        []) as unknown[];
    const notificationsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, NotificationsCapabilityModule) ??
        []) as unknown[];
    const notificationsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NotificationsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const notificationsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, NotificationsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(notificationsImports, []);
    assert.deepEqual(notificationsControllers, [NotificationsController, WebPushSubscriptionsController]);
    assert.deepEqual(notificationsProviders, [NotificationsService, WebPushSubscriptionsService]);
    assert.deepEqual(notificationsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, NotificationsController), [UserSessionGuard]);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, WebPushSubscriptionsController), [UserSessionGuard]);
    const adminReadBoundaryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminReadBoundaryCapabilityModule) ??
        []) as unknown[];
    const adminReadBoundaryControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminReadBoundaryCapabilityModule,
    ) ?? []) as unknown[];
    const adminReadBoundaryProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminReadBoundaryCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminReadBoundaryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminReadBoundaryCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminReadBoundaryImports, []);
    assert.deepEqual(adminReadBoundaryControllers, []);
    assert.deepEqual(adminReadBoundaryProviders, [AdminReadBoundary]);
    assert.deepEqual(adminReadBoundaryExports, [AdminReadBoundary]);
    const adminObservabilityImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        AdminObservabilityCapabilityModule,
    ) ?? []) as unknown[];
    const adminObservabilityControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminObservabilityCapabilityModule,
    ) ?? []) as unknown[];
    const adminObservabilityProviderDefinitions = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        AdminObservabilityCapabilityModule,
    ) ?? []) as Provider[];
    const adminObservabilityProviders = adminObservabilityProviderDefinitions.map(providerToken);
    const adminObservabilityExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        AdminObservabilityCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(adminObservabilityImports, [AdminReadBoundaryCapabilityModule]);
    assert.deepEqual(adminObservabilityControllers, [AdminObservabilityController]);
    assert.deepEqual(adminObservabilityProviders, [
        AdminObservabilityRepository,
        AdminObservabilityService,
        HostSnapshotReader,
    ]);
    assert.deepEqual(adminObservabilityExports, []);
    const hostSnapshotProvider = adminObservabilityProviderDefinitions.find(
        (provider) =>
            typeof provider === 'object' && provider !== null && providerToken(provider) === HostSnapshotReader,
    ) as { inject?: unknown[]; useFactory?: unknown } | undefined;
    assert.ok(hostSnapshotProvider);
    assert.deepEqual(hostSnapshotProvider.inject, [APP_CONFIG]);
    assert.equal(typeof hostSnapshotProvider.useFactory, 'function');
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminObservabilityController), [AdminSessionGuard]);
    const adminContentImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminContentCapabilityModule) ??
        []) as unknown[];
    const adminContentControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminContentCapabilityModule) ??
        []) as unknown[];
    const adminContentProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminContentCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminContentExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminContentCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminContentImports, [CatalogRecipesModule, ContentReleasesCapabilityModule]);
    assert.deepEqual(adminContentControllers, [AdminContentController]);
    assert.deepEqual(adminContentProviders, [AdminContentService]);
    assert.deepEqual(adminContentExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminContentController), [AdminSessionGuard]);
    const adminReadImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminReadCapabilityModule) ??
        []) as unknown[];
    const adminReadControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminReadCapabilityModule) ??
        []) as unknown[];
    const adminReadProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminReadCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminReadExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminReadCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminReadImports, []);
    assert.deepEqual(adminReadControllers, [AdminReadController]);
    assert.deepEqual(adminReadProviders, [AdminReadService]);
    assert.deepEqual(adminReadExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReadController), [AdminSessionGuard]);
    const adminRuntimeSettingsImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        AdminRuntimeSettingsCapabilityModule,
    ) ?? []) as unknown[];
    const adminRuntimeSettingsControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AdminRuntimeSettingsCapabilityModule,
    ) ?? []) as unknown[];
    const adminRuntimeSettingsProviderDefinitions = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        AdminRuntimeSettingsCapabilityModule,
    ) ?? []) as Provider[];
    const adminRuntimeSettingsProviders = adminRuntimeSettingsProviderDefinitions.map(providerToken);
    const adminRuntimeSettingsExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        AdminRuntimeSettingsCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(adminRuntimeSettingsImports, []);
    assert.deepEqual(adminRuntimeSettingsControllers, [AdminRuntimeSettingsController]);
    assert.deepEqual(adminRuntimeSettingsProviders, [AdminRuntimeSettingsService, LocalBackupStatusReader]);
    assert.deepEqual(adminRuntimeSettingsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminRuntimeSettingsController), [AdminSessionGuard]);
    const localBackupStatusProvider = adminRuntimeSettingsProviderDefinitions.find(
        (provider) =>
            typeof provider === 'object' && provider !== null && providerToken(provider) === LocalBackupStatusReader,
    ) as { inject?: unknown[]; useFactory?: (value: typeof config) => LocalBackupStatusReader } | undefined;
    assert.ok(localBackupStatusProvider);
    assert.deepEqual(localBackupStatusProvider.inject, [APP_CONFIG]);
    assert.equal(typeof localBackupStatusProvider.useFactory, 'function');
    assert.equal(
        (
            localBackupStatusProvider.useFactory?.({
                ...config,
                OBSERVABILITY_HOST_SNAPSHOT_ENABLED: true,
            }) as unknown as { file: string | undefined }
        ).file,
        '/run/meal-observability/local-backup.json',
    );
    assert.equal(
        (
            localBackupStatusProvider.useFactory?.({
                ...config,
                OBSERVABILITY_HOST_SNAPSHOT_ENABLED: false,
            }) as unknown as { file: string | undefined }
        ).file,
        undefined,
    );
    const adminReviewImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminReviewCapabilityModule) ??
        []) as unknown[];
    const adminReviewControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminReviewCapabilityModule) ??
        []) as unknown[];
    const adminReviewProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminReviewCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminReviewExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminReviewCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminReviewImports, [ContentReleasesCapabilityModule]);
    assert.deepEqual(adminReviewControllers, [AdminReviewController]);
    assert.deepEqual(adminReviewProviders, [AdminRollbackRegistry, AdminReviewService]);
    assert.deepEqual(adminReviewExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminReviewController), [AdminSessionGuard]);
    const moderatorImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ModeratorCapabilityModule) ??
        []) as unknown[];
    const moderatorControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ModeratorCapabilityModule) ??
        []) as unknown[];
    const moderatorProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ModeratorCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const moderatorExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ModeratorCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(moderatorImports, [CatalogRecipesModule, ContentReleasesCapabilityModule]);
    assert.deepEqual(moderatorControllers, [ModeratorController]);
    assert.deepEqual(moderatorProviders, [ModeratorService, ModeratorSessionGuard]);
    assert.deepEqual(moderatorExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ModeratorController), [ModeratorSessionGuard]);
    const pricingImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PricingCapabilityModule) ?? []) as unknown[];
    const pricingControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PricingCapabilityModule) ??
        []) as unknown[];
    const pricingProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PricingCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const pricingExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PricingCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(pricingImports, [ProAccessCapabilityModule]);
    assert.deepEqual(pricingControllers, [PricingController]);
    assert.deepEqual(pricingProviders, [PricingService]);
    assert.deepEqual(pricingExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, PricingController), [UserSessionGuard]);
    const financeImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FinanceCapabilityModule) ?? []) as unknown[];
    const financeControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FinanceCapabilityModule) ??
        []) as unknown[];
    const financeProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FinanceCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const financeExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FinanceCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(financeImports, [ProAccessCapabilityModule]);
    assert.deepEqual(financeControllers, [FinanceController]);
    assert.deepEqual(financeProviders, [FinanceService]);
    assert.deepEqual(financeExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, FinanceController), [UserSessionGuard]);
    const subscriptionSettingsImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        SubscriptionSettingsCapabilityModule,
    ) ?? []) as unknown[];
    const subscriptionSettingsControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        SubscriptionSettingsCapabilityModule,
    ) ?? []) as unknown[];
    const subscriptionSettingsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SubscriptionSettingsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const subscriptionSettingsExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        SubscriptionSettingsCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(subscriptionSettingsImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(subscriptionSettingsControllers, [SubscriptionSettingsController]);
    assert.deepEqual(subscriptionSettingsProviders, [SubscriptionSettingsService]);
    assert.deepEqual(subscriptionSettingsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, SubscriptionSettingsController), [UserSessionGuard]);
    const familyImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, FamilyCapabilityModule) ?? []) as unknown[];
    const familyControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, FamilyCapabilityModule) ??
        []) as unknown[];
    const familyProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, FamilyCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const familyExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, FamilyCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(familyImports, [EntitlementsCapabilityModule]);
    assert.deepEqual(familyControllers, [FamilyController]);
    assert.deepEqual(familyProviders, [FamilyService]);
    assert.deepEqual(familyExports, []);
    const aiProviderImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AiProviderCapabilityModule) ??
        []) as unknown[];
    const aiProviderControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiProviderCapabilityModule) ??
        []) as unknown[];
    const aiProviderProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AiProviderCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const aiProviderExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AiProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(aiProviderImports, []);
    assert.deepEqual(aiProviderControllers, []);
    assert.deepEqual(aiProviderProviders, [
        AiProvider,
        AiProviderSimulator,
        AI_V2_PROVIDER_PORT,
        AI_V2_PROVIDER_RUNTIME,
    ]);
    assert.deepEqual(aiProviderExports, [AiProvider, AI_V2_PROVIDER_PORT, AI_V2_PROVIDER_RUNTIME]);
    const aiImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AiCapabilityModule) ?? []) as unknown[];
    const aiControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AiCapabilityModule) ?? []) as unknown[];
    const aiProviders = ((Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AiCapabilityModule) ?? []) as Provider[]).map(
        providerToken,
    );
    const aiExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AiCapabilityModule) ?? []) as unknown[];
    assert.deepEqual(aiImports, [
        AiProviderCapabilityModule,
        EntitlementsCapabilityModule,
        LegalConsentsCapabilityModule,
        OperationalRuntimeCapabilityModule,
    ]);
    assert.deepEqual(aiControllers, [AiController]);
    assert.deepEqual(aiProviders, [
        AiService,
        AiReconciliationService,
        AiV2ProviderOperationStore,
        AiV2CulinaryExecutor,
        AiV2CulinaryInternalService,
        AiV2SubstitutionExecutor,
        AiV2SubstitutionInternalService,
        AiV2PublicActivationGate,
    ]);
    assert.deepEqual(aiExports, [AiService]);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AiController), [UserSessionGuard]);
    const proOverviewImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProOverviewCapabilityModule) ??
        []) as unknown[];
    const proOverviewControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProOverviewCapabilityModule) ??
        []) as unknown[];
    const proOverviewProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProOverviewCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const proOverviewExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProOverviewCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(proOverviewImports, [AiCapabilityModule, ProAccessCapabilityModule]);
    assert.deepEqual(proOverviewControllers, [ProOverviewController]);
    assert.deepEqual(proOverviewProviders, [ProOverviewService]);
    assert.deepEqual(proOverviewExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ProOverviewController), [UserSessionGuard]);
    const paymentProviderImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PaymentProviderCapabilityModule) ??
        []) as unknown[];
    const paymentProviderControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        PaymentProviderCapabilityModule,
    ) ?? []) as unknown[];
    const paymentProviderProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentProviderCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const paymentProviderExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PaymentProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(paymentProviderImports, []);
    assert.deepEqual(paymentProviderControllers, []);
    assert.deepEqual(paymentProviderProviders, [DisabledPaymentProvider, PAYMENT_PROVIDER]);
    assert.deepEqual(paymentProviderExports, [PAYMENT_PROVIDER]);
    const refundProviderImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RefundProviderCapabilityModule) ??
        []) as unknown[];
    const refundProviderControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        RefundProviderCapabilityModule,
    ) ?? []) as unknown[];
    const refundProviderProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RefundProviderCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const refundProviderExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, RefundProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(refundProviderImports, []);
    assert.deepEqual(refundProviderControllers, []);
    assert.deepEqual(refundProviderProviders, [DisabledRefundProvider, REFUND_PROVIDER]);
    assert.deepEqual(refundProviderExports, [REFUND_PROVIDER]);
    const paymentRepositoryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, PaymentRepositoryCapabilityModule) ??
        []) as unknown[];
    const paymentRepositoryControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        PaymentRepositoryCapabilityModule,
    ) ?? []) as unknown[];
    const paymentRepositoryProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentRepositoryCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const paymentRepositoryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, PaymentRepositoryCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(paymentRepositoryImports, []);
    assert.deepEqual(paymentRepositoryControllers, []);
    assert.deepEqual(paymentRepositoryProviders, [PostgresPaymentRepository, PAYMENT_REPOSITORY]);
    assert.deepEqual(paymentRepositoryExports, [PAYMENT_REPOSITORY]);
    const paymentApplicationImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        PaymentApplicationCapabilityModule,
    ) ?? []) as unknown[];
    const paymentApplicationControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        PaymentApplicationCapabilityModule,
    ) ?? []) as unknown[];
    const paymentApplicationProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentApplicationCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const paymentApplicationExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        PaymentApplicationCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(paymentApplicationImports, [
        PaymentProviderCapabilityModule,
        RefundProviderCapabilityModule,
        PaymentRepositoryCapabilityModule,
    ]);
    assert.deepEqual(paymentApplicationControllers, []);
    assert.deepEqual(paymentApplicationProviders, [PaymentApplicationService]);
    assert.deepEqual(paymentApplicationExports, [PaymentApplicationService]);
    const adminBillingImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminBillingCapabilityModule) ??
        []) as unknown[];
    const adminBillingControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminBillingCapabilityModule) ??
        []) as unknown[];
    const adminBillingProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminBillingCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminBillingExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminBillingCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminBillingImports, [PaymentApplicationCapabilityModule]);
    assert.deepEqual(adminBillingControllers, [AdminBillingController]);
    assert.deepEqual(adminBillingProviders, [AdminBillingService]);
    assert.deepEqual(adminBillingExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminBillingController), [AdminSessionGuard]);
    const adminNewsImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminNewsCapabilityModule) ??
        []) as unknown[];
    const adminNewsControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminNewsCapabilityModule) ??
        []) as unknown[];
    const adminNewsProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminNewsCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const adminNewsExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AdminNewsCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(adminNewsImports, [EntitlementsCapabilityModule, LegalConsentsCapabilityModule]);
    assert.deepEqual(adminNewsControllers, [AdminNewsController, NewsPublicController]);
    assert.deepEqual(adminNewsProviders, [AdminNewsService, ScheduledNewsRunner, NewsPublicService]);
    assert.deepEqual(adminNewsExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, AdminNewsController), [AdminSessionGuard]);
    const newsReadHandler = Object.getOwnPropertyDescriptor(NewsPublicController.prototype, 'read')?.value as object;
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, newsReadHandler), [UserSessionGuard]);
    const registrationRiskImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, RegistrationRiskCapabilityModule) ??
        []) as unknown[];
    const registrationRiskControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        RegistrationRiskCapabilityModule,
    ) ?? []) as unknown[];
    const registrationRiskProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RegistrationRiskCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const registrationRiskExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, RegistrationRiskCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(registrationRiskImports, []);
    assert.deepEqual(registrationRiskControllers, []);
    assert.deepEqual(registrationRiskProviders, [RegistrationRiskPolicy]);
    assert.deepEqual(registrationRiskExports, [RegistrationRiskPolicy]);
    const accountMailImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AccountMailOutboxCapabilityModule) ??
        []) as unknown[];
    const accountMailControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AccountMailOutboxCapabilityModule,
    ) ?? []) as unknown[];
    const accountMailProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        AccountMailOutboxCapabilityModule,
    ) ?? []) as Provider[];
    const accountMailProviders = accountMailProviderMetadata.map(providerToken);
    const accountMailExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AccountMailOutboxCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(accountMailImports, []);
    assert.deepEqual(accountMailControllers, []);
    assert.deepEqual(accountMailProviders, [DisabledAccountMailOutbox, PostgresAccountMailOutbox, ACCOUNT_MAIL_OUTBOX]);
    assert.deepEqual(accountMailExports, [ACCOUNT_MAIL_OUTBOX]);
    const accountMailSelector = accountMailProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === ACCOUNT_MAIL_OUTBOX,
    ) as
        | {
              provide: typeof ACCOUNT_MAIL_OUTBOX;
              useFactory: (...args: unknown[]) => unknown;
          }
        | undefined;
    assert.ok(accountMailSelector);
    const disabledAccountMail = new DisabledAccountMailOutbox();
    const postgresAccountMail = new PostgresAccountMailOutbox();
    const selectAccountMail = accountMailSelector.useFactory as (
        candidate: typeof config,
        disabled: DisabledAccountMailOutbox,
        postgres: PostgresAccountMailOutbox,
    ) => DisabledAccountMailOutbox | PostgresAccountMailOutbox;
    assert.equal(selectAccountMail(config, disabledAccountMail, postgresAccountMail), disabledAccountMail);
    assert.equal(
        selectAccountMail({ ...config, ACCOUNT_MAIL_ENABLED: true }, disabledAccountMail, postgresAccountMail),
        postgresAccountMail,
    );
    const accountServiceImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AccountServiceCapabilityModule) ??
        []) as unknown[];
    const accountServiceControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        AccountServiceCapabilityModule,
    ) ?? []) as unknown[];
    const accountServiceProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AccountServiceCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const accountServiceExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AccountServiceCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(accountServiceImports, [
        RegistrationRiskCapabilityModule,
        LegalConsentsCapabilityModule,
        AccountMailOutboxCapabilityModule,
    ]);
    assert.deepEqual(accountServiceControllers, []);
    assert.deepEqual(accountServiceProviders, [AccountService]);
    assert.deepEqual(accountServiceExports, [AccountService]);
    const accountHttpImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AccountHttpCapabilityModule) ??
        []) as unknown[];
    const accountHttpControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AccountHttpCapabilityModule) ??
        []) as unknown[];
    const accountHttpProviders = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AccountHttpCapabilityModule) ??
        []) as unknown[];
    const accountHttpExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, AccountHttpCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(accountHttpImports, [AccountServiceCapabilityModule]);
    assert.deepEqual(accountHttpControllers, [AccountController, MailboxController]);
    assert.deepEqual(accountHttpProviders, []);
    assert.deepEqual(accountHttpExports, []);
    const userAuthImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, UserAuthHttpCapabilityModule) ??
        []) as unknown[];
    const userAuthControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, UserAuthHttpCapabilityModule) ??
        []) as unknown[];
    const userAuthProviders = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, UserAuthHttpCapabilityModule) ??
        []) as unknown[];
    const userAuthExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, UserAuthHttpCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(userAuthImports, []);
    assert.deepEqual(userAuthControllers, [AuthController]);
    assert.deepEqual(userAuthProviders, []);
    assert.deepEqual(userAuthExports, []);
    const authMethods = AuthController.prototype as unknown as Record<string, object>;
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, authMethods.me!), [UserSessionGuard]);
    const staffAuthMethods = StaffAuthController.prototype as unknown as Record<string, object>;
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, staffAuthMethods.me!), [StaffSessionRouteGuard]);
    const staffAuthImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, StaffAuthHttpCapabilityModule) ??
        []) as unknown[];
    const staffAuthControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StaffAuthHttpCapabilityModule) ??
        []) as unknown[];
    const staffAuthProviders = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StaffAuthHttpCapabilityModule) ??
        []) as unknown[];
    const staffAuthExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, StaffAuthHttpCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(staffAuthImports, []);
    assert.deepEqual(staffAuthControllers, [StaffAuthController]);
    assert.deepEqual(staffAuthProviders, []);
    assert.deepEqual(staffAuthExports, []);
    const mediaObjectStoreImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MediaObjectStoreCapabilityModule) ??
        []) as unknown[];
    const mediaObjectStoreControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        MediaObjectStoreCapabilityModule,
    ) ?? []) as unknown[];
    const mediaObjectStoreProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        MediaObjectStoreCapabilityModule,
    ) ?? []) as Provider[];
    const mediaObjectStoreProviders = mediaObjectStoreProviderMetadata.map(providerToken);
    const mediaObjectStoreExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, MediaObjectStoreCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(mediaObjectStoreImports, []);
    assert.deepEqual(mediaObjectStoreControllers, []);
    assert.deepEqual(mediaObjectStoreProviders, [DisabledMediaObjectStore, S3MediaObjectStore, MEDIA_OBJECT_STORE]);
    assert.deepEqual(mediaObjectStoreExports, [MEDIA_OBJECT_STORE]);
    const s3Factory = mediaObjectStoreProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === S3MediaObjectStore,
    ) as
        | {
              inject: unknown[];
              useFactory: (candidate: typeof config) => S3MediaObjectStore;
          }
        | undefined;
    assert.ok(s3Factory);
    assert.deepEqual(s3Factory.inject, [APP_CONFIG]);
    const factoryS3 = s3Factory.useFactory(config);
    assert.ok(factoryS3 instanceof S3MediaObjectStore);
    assert.deepEqual(factoryS3.status(), { configured: false, provider: null, endpoint: null });
    const mediaObjectStoreSelector = mediaObjectStoreProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === MEDIA_OBJECT_STORE,
    ) as
        | {
              inject: unknown[];
              useFactory: (
                  candidate: typeof config,
                  disabled: DisabledMediaObjectStore,
                  s3: S3MediaObjectStore,
              ) => DisabledMediaObjectStore | S3MediaObjectStore;
          }
        | undefined;
    assert.ok(mediaObjectStoreSelector);
    assert.deepEqual(mediaObjectStoreSelector.inject, [APP_CONFIG, DisabledMediaObjectStore, S3MediaObjectStore]);
    const disabledMediaObjectStore = new DisabledMediaObjectStore();
    assert.equal(
        mediaObjectStoreSelector.useFactory(config, disabledMediaObjectStore, factoryS3),
        disabledMediaObjectStore,
    );
    assert.equal(
        mediaObjectStoreSelector.useFactory(
            { ...config, MEDIA_STORAGE_ENABLED: true },
            disabledMediaObjectStore,
            factoryS3,
        ),
        factoryS3,
    );
    const mediaStorageImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MediaStorageCapabilityModule) ??
        []) as unknown[];
    const mediaStorageControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MediaStorageCapabilityModule) ??
        []) as unknown[];
    const mediaStorageProviders = (
        (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MediaStorageCapabilityModule) ?? []) as Provider[]
    ).map(providerToken);
    const mediaStorageExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, MediaStorageCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(mediaStorageImports, [MediaObjectStoreCapabilityModule]);
    assert.deepEqual(mediaStorageControllers, [MediaStorageController]);
    assert.deepEqual(mediaStorageProviders, [MediaStorageService]);
    assert.deepEqual(mediaStorageExports, []);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, MediaStorageController), [UserSessionGuard]);
    const objectStorageImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ObjectStorageProviderCapabilityModule) ??
        []) as unknown[];
    const objectStorageControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        ObjectStorageProviderCapabilityModule,
    ) ?? []) as unknown[];
    const objectStorageProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        ObjectStorageProviderCapabilityModule,
    ) ?? []) as Provider[];
    const objectStorageProviders = objectStorageProviderMetadata.map(providerToken);
    const objectStorageExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ObjectStorageProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(objectStorageImports, []);
    assert.deepEqual(objectStorageControllers, []);
    assert.deepEqual(objectStorageProviders, [DisabledObjectStorageProvider, OBJECT_STORAGE_PROVIDER]);
    assert.deepEqual(objectStorageExports, [OBJECT_STORAGE_PROVIDER]);
    const objectStorageAlias = objectStorageProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === OBJECT_STORAGE_PROVIDER,
    ) as { useExisting: typeof DisabledObjectStorageProvider } | undefined;
    assert.ok(objectStorageAlias);
    assert.equal(objectStorageAlias.useExisting, DisabledObjectStorageProvider);
    const keyManagementImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, KeyManagementProviderCapabilityModule) ??
        []) as unknown[];
    const keyManagementControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        KeyManagementProviderCapabilityModule,
    ) ?? []) as unknown[];
    const keyManagementProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        KeyManagementProviderCapabilityModule,
    ) ?? []) as Provider[];
    const keyManagementProviders = keyManagementProviderMetadata.map(providerToken);
    const keyManagementExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, KeyManagementProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(keyManagementImports, []);
    assert.deepEqual(keyManagementControllers, []);
    assert.deepEqual(keyManagementProviders, [DisabledKeyManagementProvider, KEY_MANAGEMENT_PROVIDER]);
    assert.deepEqual(keyManagementExports, [KEY_MANAGEMENT_PROVIDER]);
    const keyManagementAlias = keyManagementProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === KEY_MANAGEMENT_PROVIDER,
    ) as { useExisting: typeof DisabledKeyManagementProvider } | undefined;
    assert.ok(keyManagementAlias);
    assert.equal(keyManagementAlias.useExisting, DisabledKeyManagementProvider);
    const malwareScannerImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        MalwareScannerProviderCapabilityModule,
    ) ?? []) as unknown[];
    const malwareScannerControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        MalwareScannerProviderCapabilityModule,
    ) ?? []) as unknown[];
    const malwareScannerProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        MalwareScannerProviderCapabilityModule,
    ) ?? []) as Provider[];
    const malwareScannerProviders = malwareScannerProviderMetadata.map(providerToken);
    const malwareScannerExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        MalwareScannerProviderCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(malwareScannerImports, []);
    assert.deepEqual(malwareScannerControllers, []);
    assert.deepEqual(malwareScannerProviders, [DisabledMalwareScannerProvider, MALWARE_SCANNER_PROVIDER]);
    assert.deepEqual(malwareScannerExports, [MALWARE_SCANNER_PROVIDER]);
    const malwareScannerAlias = malwareScannerProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === MALWARE_SCANNER_PROVIDER,
    ) as { useExisting: typeof DisabledMalwareScannerProvider } | undefined;
    assert.ok(malwareScannerAlias);
    assert.equal(malwareScannerAlias.useExisting, DisabledMalwareScannerProvider);
    const emailDeliveryImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, EmailDeliveryProviderCapabilityModule) ??
        []) as unknown[];
    const emailDeliveryControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        EmailDeliveryProviderCapabilityModule,
    ) ?? []) as unknown[];
    const emailDeliveryProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        EmailDeliveryProviderCapabilityModule,
    ) ?? []) as Provider[];
    const emailDeliveryProviders = emailDeliveryProviderMetadata.map(providerToken);
    const emailDeliveryExports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, EmailDeliveryProviderCapabilityModule) ??
        []) as unknown[];
    assert.deepEqual(emailDeliveryImports, []);
    assert.deepEqual(emailDeliveryControllers, []);
    assert.deepEqual(emailDeliveryProviders, [DisabledEmailDeliveryProvider, EMAIL_DELIVERY_PROVIDER]);
    assert.deepEqual(emailDeliveryExports, [EMAIL_DELIVERY_PROVIDER]);
    const emailDeliveryAlias = emailDeliveryProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === EMAIL_DELIVERY_PROVIDER,
    ) as { useExisting: typeof DisabledEmailDeliveryProvider } | undefined;
    assert.ok(emailDeliveryAlias);
    assert.equal(emailDeliveryAlias.useExisting, DisabledEmailDeliveryProvider);
    const webPushDeliveryImports = (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        WebPushDeliveryProviderCapabilityModule,
    ) ?? []) as unknown[];
    const webPushDeliveryControllers = (Reflect.getMetadata(
        MODULE_METADATA.CONTROLLERS,
        WebPushDeliveryProviderCapabilityModule,
    ) ?? []) as unknown[];
    const webPushDeliveryProviderMetadata = (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        WebPushDeliveryProviderCapabilityModule,
    ) ?? []) as Provider[];
    const webPushDeliveryProviders = webPushDeliveryProviderMetadata.map(providerToken);
    const webPushDeliveryExports = (Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        WebPushDeliveryProviderCapabilityModule,
    ) ?? []) as unknown[];
    assert.deepEqual(webPushDeliveryImports, []);
    assert.deepEqual(webPushDeliveryControllers, []);
    assert.deepEqual(webPushDeliveryProviders, [
        DisabledWebPushDeliveryProvider,
        VapidWebPushProvider,
        WEB_PUSH_DELIVERY_PROVIDER,
    ]);
    assert.deepEqual(webPushDeliveryExports, [WEB_PUSH_DELIVERY_PROVIDER]);
    const webPushDeliverySelector = webPushDeliveryProviderMetadata.find(
        (provider) =>
            typeof provider === 'object' &&
            provider !== null &&
            'provide' in provider &&
            provider.provide === WEB_PUSH_DELIVERY_PROVIDER,
    ) as
        | {
              inject: unknown[];
              useFactory: (
                  candidate: typeof config,
                  disabled: DisabledWebPushDeliveryProvider,
                  vapid: VapidWebPushProvider,
              ) => DisabledWebPushDeliveryProvider | VapidWebPushProvider;
          }
        | undefined;
    assert.ok(webPushDeliverySelector);
    assert.deepEqual(webPushDeliverySelector.inject, [
        APP_CONFIG,
        DisabledWebPushDeliveryProvider,
        VapidWebPushProvider,
    ]);
    const disabledWebPush = new DisabledWebPushDeliveryProvider();
    const vapidWebPush = new VapidWebPushProvider(config);
    assert.equal(webPushDeliverySelector.useFactory(config, disabledWebPush, vapidWebPush), disabledWebPush);
    assert.equal(
        webPushDeliverySelector.useFactory({ ...config, WEB_PUSH_ENABLED: true }, disabledWebPush, vapidWebPush),
        vapidWebPush,
    );
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, FamilyController), [UserSessionGuard]);
    for (const upstream of [
        EntitlementsCapabilityModule,
        RecommendationsCapabilityModule,
        AllergenIntelligenceCapabilityModule,
    ]) {
        const upstreamImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, upstream) ?? []) as unknown[];
        assert.equal(upstreamImports.includes(RecipesCapabilityModule), false, upstream.name);
    }
    const coreProviders = (core.providers ?? []).map(providerToken);
    for (const provider of [
        DatabaseService,
        AuthService,
        AdminAccessService,
        AuthCookies,
        UserSessionGuard,
        StaffSessionGuard,
        AdminSessionGuard,
    ])
        assert.equal(coreProviders.filter((token) => token === provider).length, 1, provider.name);
    assert.equal(coreProviders.filter((token) => token === STAFF_SESSION_GUARD).length, 1);
});

void test('HTTP composition has exact root ownership and a unique reachable module graph', () => {
    const root = AppModule.configure(config);
    assert.deepEqual(root.controllers ?? [], []);
    const rootProviders = root.providers ?? [];
    assert.equal(rootProviders.length, 2);
    assert.deepEqual(
        rootProviders.map((provider) => {
            assert.equal(typeof provider, 'object');
            assert.ok(provider && 'provide' in provider && 'useClass' in provider);
            return { provide: provider.provide, useClass: provider.useClass.name };
        }),
        [
            { provide: APP_GUARD, useClass: 'AdminNetworkGuard' },
            { provide: APP_GUARD, useClass: 'CsrfGuard' },
        ],
    );

    const visited = new Set<unknown>();
    const controllerOwners = new Map<unknown, string[]>();
    const providerOwners = new Map<unknown, string[]>();
    const addOwner = (owners: Map<unknown, string[]>, token: unknown, owner: string): void => {
        owners.set(token, [...(owners.get(token) ?? []), owner]);
    };
    const visit = (candidate: unknown): void => {
        const dynamic =
            typeof candidate === 'object' && candidate !== null && 'module' in candidate
                ? (candidate as DynamicModule)
                : null;
        const moduleClass = dynamic?.module ?? candidate;
        if (visited.has(moduleClass)) return;
        visited.add(moduleClass);
        const owner = typeof moduleClass === 'function' ? moduleClass.name : String(moduleClass);
        const controllers =
            dynamic?.controllers ??
            (typeof moduleClass === 'function'
                ? (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleClass) as unknown[] | undefined)
                : []) ??
            [];
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
        for (const controller of controllers) addOwner(controllerOwners, controller, owner);
        for (const provider of providers) addOwner(providerOwners, providerToken(provider), owner);
        for (const imported of imports) visit(imported);
    };
    visit(root);

    assert.equal(controllerOwners.size, 70);
    assert.equal(providerOwners.size, 133);
    for (const [controller, owners] of controllerOwners)
        assert.equal(owners.length, 1, `duplicate controller ${String(controller)}: ${owners.join(', ')}`);
    for (const [provider, owners] of providerOwners) {
        if (provider === APP_GUARD) assert.deepEqual(owners, ['AppModule', 'AppModule']);
        else assert.equal(owners.length, 1, `duplicate provider ${String(provider)}: ${owners.join(', ')}`);
    }

    const contextModuleNames: string[] = [];
    const collectContextModules = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) collectContextModules(target);
            else if (entry.name.endsWith('.module.ts')) {
                const moduleClass = /export\s+class\s+([A-Za-z_$][\w$]*Module)\b/u.exec(
                    readFileSync(target, 'utf8'),
                )?.[1];
                assert.ok(moduleClass, target);
                contextModuleNames.push(moduleClass);
            }
        }
    };
    collectContextModules(path.resolve('src/contexts'));
    assert.equal(contextModuleNames.length, 81);
    assert.deepEqual(
        [...contextModuleNames].sort(),
        [...visited]
            .filter((moduleClass): moduleClass is { name: string } => typeof moduleClass === 'function')
            .map((moduleClass) => moduleClass.name)
            .filter((name) => contextModuleNames.includes(name))
            .sort(),
    );
});
