import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readConfig } from '../src/app/config.js';
import { createApp, openApiDocument } from '../src/app/create-app.js';
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
    type MediaObjectStore,
    MediaStorageController,
    MediaStorageService,
} from '../src/modules/media-storage/public.js';
import {
    DisabledEmailDeliveryProvider,
    DisabledWebPushDeliveryProvider,
    EMAIL_DELIVERY_PROVIDER,
    VapidWebPushProvider,
    WEB_PUSH_DELIVERY_PROVIDER,
    type EmailDeliveryProvider,
    type WebPushDeliveryProvider,
} from '../src/modules/delivery-infrastructure/public.js';
import {
    DisabledKeyManagementProvider,
    DisabledMalwareScannerProvider,
    DisabledObjectStorageProvider,
    KEY_MANAGEMENT_PROVIDER,
    MALWARE_SCANNER_PROVIDER,
    OBJECT_STORAGE_PROVIDER,
    type KeyManagementProvider,
    type MalwareScannerProvider,
    type ObjectStorageProvider,
} from '../src/modules/media-infrastructure/public.js';
import { HealthController } from '../src/modules/health/public.js';
import { AiController, AiProvider, AiReconciliationService, AiService } from '../src/modules/ai/public.js';
import { AiAppealsController, AiAppealsService } from '../src/modules/ai-appeals/public.js';
import {
    ACCOUNT_MAIL_OUTBOX,
    AccountController,
    AccountService,
    DisabledAccountMailOutbox,
    MailboxController,
    PostgresAccountMailOutbox,
    RegistrationRiskPolicy,
    registrationRiskConfig,
    resolveAccountMailRuntime,
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
    TelemetryService,
} from '../src/modules/telemetry/public.js';
import {
    DisabledSecretProvider,
    PROVIDER_TELEMETRY,
    ProviderObserver,
    SECRET_PROVIDER,
} from '../src/modules/provider-runtime/public.js';
import { WorkerRuntimeFactory } from '../src/infrastructure/workers/worker-runtime.factory.js';
import { ApiExceptionFilter } from '../src/shared/http/response.js';
import { APP_CONFIG } from '../src/shared/config/app-config.js';

const config = readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

void test('runtime composition keeps singleton services, guards and exact OpenAPI', async () => {
    const app = await createApp(config);
    try {
        const database = app.get(DatabaseService);
        const auth = app.get(AuthService);
        const access = app.get(AdminAccessService);
        const cookies = app.get(AuthCookies);
        const staffSessionGuard = app.get(StaffSessionGuard);
        const staffSessionGuardToken = app.get<StaffSessionGuard>(STAFF_SESSION_GUARD);
        const staffSessionRouteGuard = app.get<{ staff: StaffSessionGuard }>(StaffSessionRouteGuard);
        assert.equal(staffSessionGuardToken, staffSessionGuard);
        assert.equal(staffSessionRouteGuard.staff, staffSessionGuard);
        const adminAuthController = app.get<{
            auth: AuthService;
            cookies: AuthCookies;
            access: AdminAccessService;
        }>(AdminAuthController);
        assert.equal(adminAuthController.auth, auth);
        assert.equal(adminAuthController.cookies, cookies);
        assert.equal(adminAuthController.access, access);
        const authController = app.get<{ auth: AuthService; cookies: AuthCookies }>(AuthController);
        assert.equal(authController.auth, auth);
        assert.equal(authController.cookies, cookies);
        const staffAuthController = app.get<{ auth: AuthService; cookies: AuthCookies }>(StaffAuthController);
        assert.equal(staffAuthController.auth, auth);
        assert.equal(staffAuthController.cookies, cookies);
        const mediaObjectStore = app.get<MediaObjectStore>(MEDIA_OBJECT_STORE);
        const disabledMediaObjectStore = app.get(DisabledMediaObjectStore);
        const mediaStorage = app.get<{
            database: DatabaseService;
            config: unknown;
            objects: unknown;
        }>(MediaStorageService);
        const mediaStorageController = app.get<{ media: MediaStorageService }>(MediaStorageController);
        assert.equal(mediaObjectStore, disabledMediaObjectStore);
        assert.deepEqual(disabledMediaObjectStore.status(), { configured: false, provider: null, endpoint: null });
        await assert.rejects(disabledMediaObjectStore.preflight(), /not enabled/);
        assert.equal(mediaStorage.database, database);
        assert.equal(mediaStorage.config, app.get(APP_CONFIG));
        assert.equal(mediaStorage.objects, mediaObjectStore);
        assert.equal(mediaStorageController.media, mediaStorage);
        const objectStorage = app.get<ObjectStorageProvider>(OBJECT_STORAGE_PROVIDER);
        const disabledObjectStorage = app.get(DisabledObjectStorageProvider);
        assert.equal(objectStorage, disabledObjectStorage);
        assert.deepEqual(objectStorage.status(), { configured: false, provider: null });
        const keyManagement = app.get<KeyManagementProvider>(KEY_MANAGEMENT_PROVIDER);
        const disabledKeyManagement = app.get(DisabledKeyManagementProvider);
        assert.equal(keyManagement, disabledKeyManagement);
        assert.deepEqual(keyManagement.status(), { configured: false, provider: null });
        const malwareScanner = app.get<MalwareScannerProvider>(MALWARE_SCANNER_PROVIDER);
        const disabledMalwareScanner = app.get(DisabledMalwareScannerProvider);
        assert.equal(malwareScanner, disabledMalwareScanner);
        assert.deepEqual(malwareScanner.status(), { configured: false, provider: null });
        const emailDelivery = app.get<EmailDeliveryProvider>(EMAIL_DELIVERY_PROVIDER);
        const disabledEmailDelivery = app.get(DisabledEmailDeliveryProvider);
        assert.equal(emailDelivery, disabledEmailDelivery);
        assert.deepEqual(emailDelivery.status(), { configured: false, provider: null });
        const webPushDelivery = app.get<WebPushDeliveryProvider>(WEB_PUSH_DELIVERY_PROVIDER);
        const disabledWebPushDelivery = app.get(DisabledWebPushDeliveryProvider);
        const vapidWebPushDelivery = app.get<{ config: unknown }>(VapidWebPushProvider);
        assert.equal(webPushDelivery, disabledWebPushDelivery);
        assert.deepEqual(webPushDelivery.status(), { configured: false, provider: null });
        assert.equal(vapidWebPushDelivery.config, app.get(APP_CONFIG));
        const adminAcceptanceRepository = app.get<{
            database: DatabaseService;
        }>(AdminAcceptanceTestsRepository);
        const adminAcceptanceService = app.get<{
            repository: AdminAcceptanceTestsRepository;
            config: unknown;
        }>(AdminAcceptanceTestsService);
        const adminAcceptanceController = app.get<{
            service: AdminAcceptanceTestsService;
        }>(AdminAcceptanceTestsController);
        assert.equal(adminAcceptanceRepository.database, database);
        assert.equal(adminAcceptanceService.repository, adminAcceptanceRepository);
        assert.equal(adminAcceptanceService.config, app.get(APP_CONFIG));
        assert.equal(adminAcceptanceController.service, adminAcceptanceService);
        const notifications = app.get<{
            database: DatabaseService;
            config: unknown;
        }>(NotificationsService);
        const webPushSubscriptions = app.get<{
            database: DatabaseService;
            appConfig: unknown;
        }>(WebPushSubscriptionsService);
        const notificationsController = app.get<{
            service: NotificationsService;
        }>(NotificationsController);
        const webPushSubscriptionsController = app.get<{
            webPush: WebPushSubscriptionsService;
        }>(WebPushSubscriptionsController);
        assert.equal(notifications.database, database);
        assert.equal(notifications.config, app.get(APP_CONFIG));
        assert.equal(webPushSubscriptions.database, database);
        assert.equal(webPushSubscriptions.appConfig, app.get(APP_CONFIG));
        assert.equal(notificationsController.service, notifications);
        assert.equal(webPushSubscriptionsController.webPush, webPushSubscriptions);
        const adminReadBoundary = app.get<{
            database: DatabaseService;
        }>(AdminReadBoundary);
        const adminObservabilityRepository = app.get<{
            database: DatabaseService;
        }>(AdminObservabilityRepository);
        const hostSnapshotReader = app.get<{
            file: string | undefined;
        }>(HostSnapshotReader);
        const adminObservability = app.get<{
            boundary: AdminReadBoundary;
            repository: AdminObservabilityRepository;
            host: HostSnapshotReader;
        }>(AdminObservabilityService);
        const adminObservabilityController = app.get<{
            observability: AdminObservabilityService;
        }>(AdminObservabilityController);
        assert.equal(adminReadBoundary.database, database);
        assert.equal(adminObservability.boundary, adminReadBoundary);
        assert.equal(adminObservabilityRepository.database, database);
        assert.equal(adminObservability.repository, adminObservabilityRepository);
        assert.equal(adminObservability.host, hostSnapshotReader);
        assert.equal(
            hostSnapshotReader.file,
            config.OBSERVABILITY_HOST_SNAPSHOT_ENABLED ? config.OBSERVABILITY_HOST_SNAPSHOT_FILE : undefined,
        );
        assert.equal(adminObservabilityController.observability, adminObservability);
        const adminContent = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
            lifecycle: RecipeLifecycleService;
            releases?: ContentReleasesService;
        }>(AdminContentService);
        const adminContentController = app.get<{
            service: AdminContentService;
        }>(AdminContentController);
        assert.equal(adminContent.database, database);
        assert.equal(adminContent.access, access);
        assert.equal(adminContent.lifecycle, app.get(RecipeLifecycleService));
        assert.equal(adminContent.releases, app.get(ContentReleasesService));
        assert.equal(adminContentController.service, adminContent);
        const adminRead = app.get<{
            database: DatabaseService;
        }>(AdminReadService);
        const adminReadController = app.get<{
            admin: AdminReadService;
        }>(AdminReadController);
        assert.equal(adminRead.database, database);
        assert.equal(adminReadController.admin, adminRead);
        const localBackupStatusReader = app.get<{
            file: string | undefined;
        }>(LocalBackupStatusReader);
        const adminRuntimeSettings = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
            localBackup: LocalBackupStatusReader;
            config: unknown;
        }>(AdminRuntimeSettingsService);
        const adminRuntimeSettingsController = app.get<{
            service: AdminRuntimeSettingsService;
        }>(AdminRuntimeSettingsController);
        assert.equal(adminRuntimeSettings.database, database);
        assert.equal(adminRuntimeSettings.access, access);
        assert.equal(adminRuntimeSettings.localBackup, localBackupStatusReader);
        assert.equal(adminRuntimeSettings.config, app.get(APP_CONFIG));
        assert.equal(adminRuntimeSettingsController.service, adminRuntimeSettings);
        const adminRollbackRegistry = app.get<{
            releases: ContentReleasesService;
        }>(AdminRollbackRegistry);
        const adminReview = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
            rollbackRegistry: AdminRollbackRegistry;
        }>(AdminReviewService);
        const adminReviewController = app.get<{
            service: AdminReviewService;
        }>(AdminReviewController);
        assert.equal(adminRollbackRegistry.releases, app.get(ContentReleasesService));
        assert.equal(adminReview.database, database);
        assert.equal(adminReview.access, access);
        assert.equal(adminReview.rollbackRegistry, adminRollbackRegistry);
        assert.equal(adminReviewController.service, adminReview);
        const moderator = app.get<{
            database: DatabaseService;
            lifecycle: RecipeLifecycleService;
            releases?: ContentReleasesService;
        }>(ModeratorService);
        const moderatorGuard = app.get<{
            staff: StaffSessionGuard;
        }>(ModeratorSessionGuard);
        const moderatorController = app.get<{
            service: ModeratorService;
        }>(ModeratorController);
        assert.equal(moderator.database, database);
        assert.equal(moderator.lifecycle, app.get(RecipeLifecycleService));
        assert.equal(moderator.releases, app.get(ContentReleasesService));
        assert.equal(moderatorGuard.staff, staffSessionGuard);
        assert.equal(moderatorController.service, moderator);
        const policyInstance = app.get(RecipePolicyService);
        const policy = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
        }>(RecipePolicyService);
        const controller = app.get<{
            policy: RecipePolicyService;
        }>(RecipePolicyController);
        const userGuard = app.get<{
            auth: AuthService;
            cookies: AuthCookies;
        }>(UserSessionGuard);
        const adminGuard = app.get<{
            access: AdminAccessService;
            cookies: AuthCookies;
        }>(AdminSessionGuard);
        assert.equal(policy.database, database);
        assert.equal(policy.access, access);
        assert.equal(controller.policy, policyInstance);
        assert.equal(userGuard.auth, auth);
        assert.equal(userGuard.cookies, cookies);
        assert.equal(adminGuard.access, access);
        assert.equal(adminGuard.cookies, cookies);
        const recipeLifecycle = app.get(RecipeLifecycleService);
        const entitlements = app.get(EntitlementsService);
        const entitlementsController = app.get<{
            service: EntitlementsService;
        }>(EntitlementsController);
        const subscriptionSettings = app.get<{
            database: DatabaseService;
            entitlements: EntitlementsService;
        }>(SubscriptionSettingsService);
        const subscriptionSettingsController = app.get<{
            service: SubscriptionSettingsService;
        }>(SubscriptionSettingsController);
        const family = app.get<{
            database: DatabaseService;
            entitlements: EntitlementsService;
        }>(FamilyService);
        const familyController = app.get<{
            service: FamilyService;
        }>(FamilyController);
        const workspace = app.get<{
            database: DatabaseService;
            policy: RecipePolicyService;
            entitlements: EntitlementsService;
            legalConsents: LegalConsentService;
            lifecycle: RecipeLifecycleService;
            releases?: ContentReleasesService;
        }>(RecipeWorkspaceService);
        const workspaceController = app.get<{
            workspace: RecipeWorkspaceService;
        }>(RecipeWorkspaceController);
        assert.equal(entitlementsController.service, entitlements);
        assert.equal(subscriptionSettings.database, database);
        assert.equal(subscriptionSettings.entitlements, entitlements);
        assert.equal(subscriptionSettingsController.service, subscriptionSettings);
        assert.equal(family.database, database);
        assert.equal(family.entitlements, entitlements);
        assert.equal(familyController.service, family);
        assert.equal(workspace.database, database);
        assert.equal(workspace.policy, policyInstance);
        assert.equal(workspace.entitlements, entitlements);
        assert.equal(workspace.legalConsents, app.get(LegalConsentService));
        assert.equal(workspace.lifecycle, recipeLifecycle);
        assert.equal(workspace.releases, app.get(ContentReleasesService));
        assert.equal(workspaceController.workspace, workspace);
        const familyChat = app.get<{
            entitlements: EntitlementsService;
        }>(FamilyChatService);
        const familyChatController = app.get<{
            service: FamilyChatService;
        }>(FamilyChatController);
        assert.equal(familyChat.entitlements, entitlements);
        assert.equal(familyChatController.service, familyChat);
        const nutrition = app.get<NutritionService>(NutritionService);
        const nutritionController = app.get<{
            nutrition: NutritionService;
        }>(NutritionController);
        assert.equal(nutritionController.nutrition, nutrition);
        const inventoryIngest = app.get<{
            database: DatabaseService;
            config: unknown;
        }>(InventoryIngestService);
        const inventoryIngestController = app.get<{
            ingest: InventoryIngestService;
        }>(InventoryIngestController);
        assert.equal(inventoryIngest.database, app.get(DatabaseService));
        assert.equal(inventoryIngest.config, app.get(APP_CONFIG));
        assert.equal(inventoryIngestController.ingest, inventoryIngest);
        const operationsWorkspace = app.get<{
            database: DatabaseService;
        }>(OperationsWorkspaceService);
        const operationsController = app.get<{
            service: OperationsWorkspaceService;
        }>(OperationsWorkspaceController);
        const operationalMaintenance = app.get<{
            database: DatabaseService;
        }>(OperationalMaintenanceService);
        assert.equal(operationsWorkspace.database, app.get(DatabaseService));
        assert.equal(operationsController.service, operationsWorkspace);
        assert.equal(operationalMaintenance.database, app.get(DatabaseService));
        const adminGovernance = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
        }>(AdminGovernanceService);
        const adminGovernanceController = app.get<{
            service: AdminGovernanceService;
        }>(AdminGovernanceController);
        assert.equal(adminGovernance.database, database);
        assert.equal(adminGovernance.access, access);
        assert.equal(adminGovernanceController.service, adminGovernance);
        const criticalReauth = app.get(CriticalReauthService);
        const accountLifecycleController = app.get<{
            service: AccountLifecycleService;
            reauth: CriticalReauthService;
        }>(AccountLifecycleController);
        const accountLifecycle = app.get<{
            database: DatabaseService;
            reauth: CriticalReauthService;
            auth: AuthService;
            adminAccess: AdminAccessService;
        }>(AccountLifecycleService);
        const adminAccountLifecycleController = app.get<{
            service: AccountLifecycleService;
        }>(AdminAccountLifecycleController);
        const exportsService = app.get<{
            reauth: CriticalReauthService;
            proAccess: ProAccessService;
        }>(ExportsService);
        assert.equal(accountLifecycleController.reauth, criticalReauth);
        assert.equal(accountLifecycleController.service, accountLifecycle);
        assert.equal(adminAccountLifecycleController.service, accountLifecycle);
        assert.equal(accountLifecycle.database, database);
        assert.equal(accountLifecycle.reauth, criticalReauth);
        assert.equal(accountLifecycle.auth, auth);
        assert.equal(accountLifecycle.adminAccess, access);
        assert.equal(exportsService.reauth, criticalReauth);
        assert.equal(exportsService.proAccess, app.get(ProAccessService));
        const exportsController = app.get<{
            exports: ExportsService;
        }>(ExportsController);
        assert.equal(exportsController.exports, exportsService);
        const inventory = app.get(InventoryService);
        const inventoryController = app.get<{
            inventory: InventoryService;
        }>(InventoryController);
        assert.equal(inventoryController.inventory, inventory);
        const products = app.get(ProductsService);
        const productsController = app.get<{
            products: ProductsService;
        }>(ProductsController);
        assert.equal(productsController.products, products);
        const recommendations = app.get(RecommendationsService);
        const recommendationsController = app.get<{
            recommendations: RecommendationsService;
        }>(RecommendationsController);
        const personalization = app.get<{
            recommendations: RecommendationsService;
        }>(PersonalizationService);
        const personalizationController = app.get<{
            service: PersonalizationService;
        }>(PersonalizationController);
        const recipes = app.get<{
            recommendations?: RecommendationsService;
        }>(RecipesService);
        assert.equal(recommendationsController.recommendations, recommendations);
        assert.equal(personalization.recommendations, recommendations);
        assert.equal(personalizationController.service, personalization);
        assert.equal(recipes.recommendations, recommendations);
        const allergenIntelligence = app.get(AllergenIntelligenceService);
        const allergenReportController = app.get<{
            service: AllergenIntelligenceService;
        }>(AllergenReportController);
        const adminAllergensController = app.get<{
            service: AllergenIntelligenceService;
        }>(AdminAllergensController);
        const recipesAllergens = app.get<{
            allergenIntelligence?: AllergenIntelligenceService;
        }>(RecipesService);
        assert.equal(allergenReportController.service, allergenIntelligence);
        assert.equal(adminAllergensController.service, allergenIntelligence);
        assert.equal(recipesAllergens.allergenIntelligence, allergenIntelligence);
        const recipesInstance = app.get(RecipesService);
        const recipesController = app.get<{
            recipes: RecipesService;
        }>(RecipesController);
        const cooking = app.get<{
            recipes?: RecipesService;
            lifecycle?: CookingLifecycleService;
            statisticsPolicy?: CookingStatisticsPolicy;
            releases?: ContentReleasesService;
        }>(CookingService);
        const cookingLifecycleInstance = app.get(CookingLifecycleService);
        const cookingStatisticsPolicy = app.get(CookingStatisticsPolicy);
        const cookingController = app.get<{
            cooking: CookingService;
        }>(CookingController);
        const cookingStatisticsController = app.get<{
            cooking: CookingService;
        }>(CookingStatisticsController);
        const shopping = app.get<{
            recipes: RecipesService;
            entitlements: EntitlementsService;
        }>(ShoppingService);
        const shoppingController = app.get<{
            shopping: ShoppingService;
        }>(ShoppingController);
        assert.equal(recipesController.recipes, recipesInstance);
        assert.equal(cooking.recipes, recipesInstance);
        assert.equal(cooking.lifecycle, cookingLifecycleInstance);
        assert.equal(cooking.statisticsPolicy, cookingStatisticsPolicy);
        assert.equal(cookingController.cooking, cooking);
        assert.equal(cookingStatisticsController.cooking, cooking);
        assert.equal(shopping.recipes, recipesInstance);
        assert.equal(shopping.entitlements, entitlements);
        assert.equal(shoppingController.shopping, shopping);
        const search = app.get<{
            database: DatabaseService;
        }>(SearchService);
        const searchController = app.get<{
            search: SearchService;
        }>(SearchController);
        assert.equal(search.database, database);
        assert.equal(searchController.search, search);
        const proAccess = app.get(ProAccessService);
        for (const consumer of [
            app.get<{ access: ProAccessService }>(ProOverviewService),
            app.get<{ proAccess: ProAccessService }>(ExportsService),
            app.get<{ access: ProAccessService }>(DiaryService),
            app.get<{ access: ProAccessService }>(FinanceService),
            app.get<{ access: ProAccessService }>(PricingService),
            app.get<{ access: ProAccessService }>(NutritionService),
            app.get<{ proAccess: ProAccessService }>(ReceiptsService),
        ])
            assert.equal('access' in consumer ? consumer.access : consumer.proAccess, proAccess);
        const finance = app.get<{
            database: DatabaseService;
            access: ProAccessService;
        }>(FinanceService);
        const financeController = app.get<{
            finance: FinanceService;
        }>(FinanceController);
        assert.equal(finance.database, database);
        assert.equal(finance.access, proAccess);
        assert.equal(financeController.finance, finance);
        const pricing = app.get<{
            database: DatabaseService;
            access: ProAccessService;
        }>(PricingService);
        const pricingController = app.get<{
            pricing: PricingService;
        }>(PricingController);
        assert.equal(pricing.database, database);
        assert.equal(pricing.access, proAccess);
        assert.equal(pricingController.pricing, pricing);
        const receipts = app.get<{
            entitlements: EntitlementsService;
            proAccess: ProAccessService;
        }>(ReceiptsService);
        const purchases = app.get<{
            entitlements: EntitlementsService;
        }>(PurchasesService);
        const receiptsController = app.get<{
            service: ReceiptsService;
        }>(ReceiptsController);
        const purchasesController = app.get<{
            service: PurchasesService;
        }>(PurchasesController);
        assert.equal(receipts.entitlements, entitlements);
        assert.equal(receipts.proAccess, proAccess);
        assert.equal(purchases.entitlements, entitlements);
        assert.equal(receiptsController.service, receipts);
        assert.equal(purchasesController.service, purchases);
        const preserves = app.get(PreservesService);
        const preservesController = app.get<{
            preserves: PreservesService;
        }>(PreservesController);
        assert.equal(preservesController.preserves, preserves);
        const telemetry = app.get(TelemetryService);
        const telemetryController = app.get<{
            telemetry: TelemetryService;
        }>(TelemetryController);
        const providerTelemetry = app.get(AdminProviderTelemetry);
        const providerTokenInstance = app.get<unknown>(PROVIDER_TELEMETRY);
        const workerSink = app.get<{
            telemetry: TelemetryService;
        }>(AdminWorkerRuntimeSink);
        const observer = app.get<{
            telemetry: unknown;
        }>(ProviderObserver);
        const workerRuntime = app.get<{
            adminTelemetry: AdminWorkerRuntimeSink;
        }>(WorkerRuntimeFactory);
        const exceptionFilter = new ApiExceptionFilter(telemetry) as unknown as { telemetry: TelemetryService };
        assert.equal(telemetryController.telemetry, telemetry);
        assert.equal(providerTokenInstance, providerTelemetry);
        assert.equal(workerSink.telemetry, telemetry);
        assert.equal(observer.telemetry, providerTelemetry);
        assert.equal(workerRuntime.adminTelemetry, app.get(AdminWorkerRuntimeSink));
        assert.equal(exceptionFilter.telemetry, telemetry);
        const workerRuntimeInstance = app.get(WorkerRuntimeFactory);
        const aiReconciliation = app.get<{
            workerRuntime: WorkerRuntimeFactory;
        }>(AiReconciliationService);
        const cookingLifecycle = app.get<{
            workerRuntime: WorkerRuntimeFactory;
        }>(CookingLifecycleService);
        assert.equal(aiReconciliation.workerRuntime, workerRuntimeInstance);
        assert.equal(cookingLifecycle.workerRuntime, workerRuntimeInstance);
        const aiProvider = app.get(AiProvider);
        const ai = app.get<{
            provider: AiProvider;
            entitlements: EntitlementsService;
            legalConsents: LegalConsentService;
        }>(AiService);
        const aiController = app.get<{ service: AiService }>(AiController);
        const proOverview = app.get<{ ai: AiService }>(ProOverviewService);
        const proOverviewController = app.get<{ service: ProOverviewService }>(ProOverviewController);
        assert.equal(ai.provider, aiProvider);
        assert.equal(ai.entitlements, entitlements);
        assert.equal(ai.legalConsents, app.get(LegalConsentService));
        assert.equal(aiController.service, ai);
        assert.equal(proOverview.ai, ai);
        assert.equal(proOverviewController.service, proOverview);
        assert.equal((proOverview as unknown as { database: DatabaseService }).database, database);
        assert.equal((proOverview as unknown as { access: ProAccessService }).access, proAccess);
        const disabledPaymentProvider = app.get(DisabledPaymentProvider);
        const paymentProvider = app.get<unknown>(PAYMENT_PROVIDER);
        const paymentApplication = app.get<{ payments: unknown; refunds: unknown; repository: unknown }>(
            PaymentApplicationService,
        );
        assert.equal(paymentProvider, disabledPaymentProvider);
        assert.equal(paymentApplication.payments, paymentProvider);
        const disabledRefundProvider = app.get(DisabledRefundProvider);
        const refundProvider = app.get<unknown>(REFUND_PROVIDER);
        assert.equal(refundProvider, disabledRefundProvider);
        assert.equal(paymentApplication.refunds, refundProvider);
        const postgresPaymentRepository = app.get<{ database: DatabaseService }>(PostgresPaymentRepository);
        const paymentRepository = app.get<unknown>(PAYMENT_REPOSITORY);
        assert.equal(paymentRepository, postgresPaymentRepository);
        assert.equal(paymentApplication.repository, paymentRepository);
        assert.equal(postgresPaymentRepository.database, database);
        const adminBilling = app.get<{
            database: DatabaseService;
            adminAccess: AdminAccessService;
            payments: PaymentApplicationService;
        }>(AdminBillingService);
        const adminBillingController = app.get<{ service: AdminBillingService }>(AdminBillingController);
        assert.equal(adminBilling.database, database);
        assert.equal(adminBilling.adminAccess, access);
        assert.equal(adminBilling.payments, paymentApplication);
        assert.equal(adminBillingController.service, adminBilling);
        const adminNews = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
            entitlements: EntitlementsService;
            legalConsents: LegalConsentService;
        }>(AdminNewsService);
        const newsPublic = app.get<{
            database: DatabaseService;
            entitlements: EntitlementsService;
        }>(NewsPublicService);
        const scheduledNews = app.get<{
            database: DatabaseService;
            entitlements: EntitlementsService;
            legalConsents: LegalConsentService;
        }>(ScheduledNewsRunner);
        const adminNewsController = app.get<{ news: AdminNewsService }>(AdminNewsController);
        const newsPublicController = app.get<{
            news: NewsPublicService;
            auth: AuthService;
            cookies: AuthCookies;
        }>(NewsPublicController);
        assert.equal(adminNews.database, database);
        assert.equal(adminNews.access, access);
        assert.equal(adminNews.entitlements, entitlements);
        assert.equal(adminNews.legalConsents, app.get(LegalConsentService));
        assert.equal(newsPublic.database, database);
        assert.equal(newsPublic.entitlements, entitlements);
        assert.equal(scheduledNews.database, database);
        assert.equal(scheduledNews.entitlements, entitlements);
        assert.equal(scheduledNews.legalConsents, app.get(LegalConsentService));
        assert.equal(adminNewsController.news, adminNews);
        assert.equal(newsPublicController.news, newsPublic);
        assert.equal(newsPublicController.auth, auth);
        assert.equal(newsPublicController.cookies, cookies);
        const registrationRisk = app.get<{
            config: ReturnType<typeof registrationRiskConfig>;
            provider: unknown;
        }>(RegistrationRiskPolicy);
        const account = app.get<{
            database: DatabaseService;
            auth: AuthService;
            config: unknown;
            registrationRisk?: RegistrationRiskPolicy;
            legalConsents?: LegalConsentService;
            accountMailOutbox?: unknown;
        }>(AccountService);
        const accountController = app.get<{ account: AccountService; cookies: AuthCookies }>(AccountController);
        const mailboxController = app.get<{ account: AccountService }>(MailboxController);
        assert.equal(account.database, database);
        assert.equal(account.auth, auth);
        assert.equal(account.config, app.get(APP_CONFIG));
        assert.equal(account.registrationRisk, registrationRisk);
        assert.equal(accountController.account, account);
        assert.equal(accountController.cookies, cookies);
        assert.equal(mailboxController.account, account);
        assert.deepEqual(registrationRisk.config, registrationRiskConfig(app.get(APP_CONFIG)));
        assert.equal(registrationRisk.provider, null);
        const accountMailOutbox = app.get<DisabledAccountMailOutbox | PostgresAccountMailOutbox>(ACCOUNT_MAIL_OUTBOX);
        assert.equal(accountMailOutbox, app.get(DisabledAccountMailOutbox));
        assert.equal(account.accountMailOutbox, accountMailOutbox);
        assert.throws(() => resolveAccountMailRuntime('production', accountMailOutbox), /outbox is not configured/);
        const legalConsents = app.get(LegalConsentService);
        const publicLegalController = app.get<{
            service: LegalConsentService;
        }>(PublicLegalController);
        const legalConsentController = app.get<{
            service: LegalConsentService;
        }>(LegalConsentController);
        const legalGuard = app.get<{
            consents: LegalConsentService;
        }>(LegalConsentGuard);
        const legalProvider = app.get(DatabaseLegalDocumentProvider);
        const legalProviderToken = app.get<unknown>(LEGAL_DOCUMENT_PROVIDER);
        assert.equal(publicLegalController.service, legalConsents);
        assert.equal(legalConsentController.service, legalConsents);
        assert.equal(legalGuard.consents, legalConsents);
        assert.equal(legalProviderToken, legalProvider);
        for (const consumer of [
            app.get<{ legalConsents?: LegalConsentService }>(AccountService),
            app.get<{ legalConsents: LegalConsentService }>(AdminNewsService),
            app.get<{ legalConsents: LegalConsentService }>(ScheduledNewsRunner),
            app.get<{ legalConsents: LegalConsentService }>(AiService),
            app.get<{ legalConsents: LegalConsentService }>(ContentReleasesService),
            app.get<{ legalConsents: LegalConsentService }>(DiaryService),
            app.get<{ legalConsents: LegalConsentService }>(NutritionService),
            app.get<{ legalConsents: LegalConsentService }>(ProfilesService),
            app.get<{ legalConsents: LegalConsentService }>(PersonalizationService),
            app.get<{ legalConsents: LegalConsentService }>(RecipeWorkspaceService),
        ])
            assert.equal(consumer.legalConsents, legalConsents);

        const diary = app.get<{
            access: ProAccessService;
            legalConsents: LegalConsentService;
        }>(DiaryService);
        const diaryController = app.get<{
            diary: DiaryService;
        }>(DiaryController);
        const mealPlan = app.get<{
            entitlements: EntitlementsService;
            diary: DiaryService;
        }>(MealPlanService);
        const mealPlanController = app.get<{
            service: MealPlanService;
        }>(MealPlanController);
        const portionsController = app.get<{
            service: MealPlanService;
        }>(PortionsController);
        assert.equal(diary.access, proAccess);
        assert.equal(diary.legalConsents, legalConsents);
        assert.equal(diaryController.diary, diary);
        assert.equal(mealPlan.entitlements, entitlements);
        assert.equal(mealPlan.diary, diary);
        assert.equal(mealPlanController.service, mealPlan);
        assert.equal(portionsController.service, mealPlan);
        const privacy = app.get<{
            database: DatabaseService;
        }>(PrivacyService);
        const privacyController = app.get<{
            service: PrivacyService;
        }>(PrivacyController);
        assert.equal(privacy.database, database);
        assert.equal(privacyController.service, privacy);
        const support = app.get<{
            database: DatabaseService;
        }>(SupportService);
        const supportController = app.get<{
            service: SupportService;
        }>(SupportController);
        assert.equal(support.database, database);
        assert.equal(supportController.service, support);
        const community = app.get<{
            database: DatabaseService;
        }>(CommunityService);
        const communityController = app.get<{
            community: CommunityService;
        }>(CommunityController);
        assert.equal(community.database, database);
        assert.equal(communityController.community, community);
        const aiAppeals = app.get<{
            database: DatabaseService;
        }>(AiAppealsService);
        const aiAppealsController = app.get<{
            appeals: AiAppealsService;
        }>(AiAppealsController);
        assert.equal(aiAppeals.database, database);
        assert.equal(aiAppealsController.appeals, aiAppeals);
        const adminSupport = app.get<{
            database: DatabaseService;
        }>(AdminSupportService);
        const adminSupportController = app.get<{
            service: AdminSupportService;
        }>(AdminSupportController);
        assert.equal(adminSupport.database, database);
        assert.equal(adminSupportController.service, adminSupport);
        const health = app.get<{
            database: DatabaseService;
        }>(HealthController);
        assert.equal(health.database, database);
        const notificationCenter = app.get<{
            database: DatabaseService;
        }>(NotificationCenterService);
        const notificationCenterController = app.get<{
            service: NotificationCenterService;
        }>(NotificationCenterController);
        assert.equal(notificationCenter.database, database);
        assert.equal(notificationCenterController.service, notificationCenter);
        const adminActions = app.get<{
            database: DatabaseService;
        }>(AdminActionsService);
        const adminActionsController = app.get<{
            actions: AdminActionsService;
        }>(AdminActionsController);
        assert.equal(adminActions.database, database);
        assert.equal(adminActionsController.actions, adminActions);
        const profiles = app.get<{
            database: DatabaseService;
            legalConsents: LegalConsentService;
        }>(ProfilesService);
        const profilesController = app.get<{
            profiles: ProfilesService;
        }>(ProfilesController);
        assert.equal(profiles.database, database);
        assert.equal(profiles.legalConsents, legalConsents);
        assert.equal(profilesController.profiles, profiles);
        const adminFreeAi = app.get<{
            database: DatabaseService;
            access: AdminAccessService;
        }>(AdminFreeAiService);
        const adminFreeAiController = app.get<{
            service: AdminFreeAiService;
        }>(AdminFreeAiController);
        assert.equal(adminFreeAi.database, database);
        assert.equal(adminFreeAi.access, access);
        assert.equal(adminFreeAiController.service, adminFreeAi);
        const familyNotes = app.get<{
            database: DatabaseService;
            entitlements: EntitlementsService;
        }>(FamilyNotesService);
        const familyNotesController = app.get<{
            service: FamilyNotesService;
        }>(FamilyNotesController);
        assert.equal(familyNotes.database, database);
        assert.equal(familyNotes.entitlements, entitlements);
        assert.equal(familyNotesController.service, familyNotes);
        const disabledOcr = app.get(DisabledOcrProvider);
        assert.equal(app.get(OCR_PROVIDER), disabledOcr);
        const disabledSecret = app.get(DisabledSecretProvider);
        assert.equal(app.get(SECRET_PROVIDER), disabledSecret);

        const releases = app.get(ContentReleasesService);
        const releasesController = app.get<{
            releases: ContentReleasesService;
        }>(ContentReleasesController);
        const achievementsController = app.get<{
            releases: ContentReleasesService;
        }>(AchievementsController);
        assert.equal(releasesController.releases, releases);
        assert.equal(achievementsController.releases, releases);
        for (const consumer of [
            app.get<{ releases?: ContentReleasesService }>(AdminContentService),
            app.get<{ releases: ContentReleasesService }>(AdminRollbackRegistry),
            app.get<{ releases?: ContentReleasesService }>(CookingService),
            app.get<{ releases?: ContentReleasesService }>(ModeratorService),
            app.get<{ releases?: ContentReleasesService }>(RecipeWorkspaceService),
        ])
            assert.equal(consumer.releases, releases);

        const expected = JSON.parse(await readFile('contracts/openapi.json', 'utf8')) as unknown;
        const actual = JSON.parse(JSON.stringify(openApiDocument(app))) as unknown;
        assert.deepEqual(actual, expected);
    } finally {
        await app.close();
    }
});
