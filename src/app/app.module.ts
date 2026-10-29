import { RecipesController } from '../modules/recipes/recipes.http.js';
import { PreservesController } from '../modules/preserves/preserves.http.js';
import { PreservesService } from '../modules/preserves/preserves.service.js';
import { RecipePolicyController } from '../modules/recipe-policy/recipe-policy.http.js';
import { RecipePolicyService } from '../modules/recipe-policy/recipe-policy.service.js';
import { RecipeWorkspaceController } from '../modules/recipe-workspace/recipe-workspace.http.js';
import { RecipeWorkspaceService } from '../modules/recipe-workspace/recipe-workspace.service.js';
import { CookingController, CookingStatisticsController } from '../modules/cooking/cooking.http.js';
import { CookingService } from '../modules/cooking/cooking.service.js';
import { CookingStatisticsPolicy } from '../modules/cooking/cooking-statistics.policy.js';
import { ShoppingController } from '../modules/shopping/shopping.http.js';
import { ShoppingService } from '../modules/shopping/shopping.service.js';
import { PurchasesController, ReceiptsController } from '../modules/receipts/receipts.http.js';
import { PurchasesService } from '../modules/receipts/purchases.service.js';
import { ReceiptsService } from '../modules/receipts/receipts.service.js';
import { MealPlanController, PortionsController } from '../modules/meal-plan/meal-plan.http.js';
import { MealPlanService } from '../modules/meal-plan/meal-plan.service.js';
import { FamilyNotesController } from '../modules/family-notes/family-notes.http.js';
import { FamilyNotesService } from '../modules/family-notes/family-notes.service.js';
import { FamilyChatController } from '../modules/family-chat/family-chat.http.js';
import { FamilyChatService } from '../modules/family-chat/family-chat.service.js';
import { PersonalizationController } from '../modules/personalization/personalization.http.js';
import { PersonalizationService } from '../modules/personalization/personalization.service.js';
import { NotificationsController } from '../modules/notifications/notifications.http.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { SupportController } from '../modules/support/support.http.js';
import { SupportService } from '../modules/support/support.service.js';
import { AiController } from '../modules/ai/ai.http.js';
import { AiService } from '../modules/ai/ai.service.js';
import { AiProvider } from '../modules/ai/ai-provider.js';
import { AiReconciliationService } from '../modules/ai/ai-reconciliation.service.js';
import { DisabledPaymentProvider, PAYMENT_PROVIDER } from '../modules/payments/payment-provider.js';
import { DisabledRefundProvider, REFUND_PROVIDER } from '../modules/payments/refunds.js';
import { PAYMENT_REPOSITORY, PaymentApplicationService } from '../modules/payments/payment-application.js';
import { PostgresPaymentRepository } from '../modules/payments/payment-postgres.repository.js';
import {
    DisabledKeyManagementProvider,
    DisabledMalwareScannerProvider,
    DisabledObjectStorageProvider,
    KEY_MANAGEMENT_PROVIDER,
    MALWARE_SCANNER_PROVIDER,
    OBJECT_STORAGE_PROVIDER,
} from '../modules/media-infrastructure/media-provider.js';
import {
    DisabledEmailDeliveryProvider,
    DisabledWebPushDeliveryProvider,
    EMAIL_DELIVERY_PROVIDER,
    WEB_PUSH_DELIVERY_PROVIDER,
} from '../modules/delivery-infrastructure/delivery-provider.js';
import { DisabledOcrProvider, OCR_PROVIDER } from '../modules/ocr-infrastructure/ocr-provider.js';
import {
    DisabledSecretProvider,
    PROVIDER_TELEMETRY,
    ProviderObserver,
    SECRET_PROVIDER,
} from '../modules/provider-runtime/provider-runtime.js';
import { AdminFreeAiController } from '../modules/admin-free-ai/admin-free-ai.http.js';
import { AdminFreeAiService } from '../modules/admin-free-ai/admin-free-ai.service.js';
import { RecipesService } from '../modules/recipes/recipes.service.js';
import { AccountService } from '../modules/account/account.service.js';
import { ACCOUNT_MAIL_OUTBOX, DisabledAccountMailOutbox } from '../modules/account/account-mail.outbox.js';
import { RegistrationRiskPolicy, registrationRiskConfig } from '../modules/account/registration-risk.policy.js';
import { InventoryController } from '../modules/inventory/inventory.http.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { InventoryIngestController } from '../modules/inventory-ingest/ingest.http.js';
import { InventoryIngestService } from '../modules/inventory-ingest/ingest.service.js';
import { ProductsController } from '../modules/products/products.http.js';
import { ProductsService } from '../modules/products/products.service.js';
import { EntitlementsController } from '../modules/entitlements/entitlements.http.js';
import { EntitlementsService } from '../modules/entitlements/entitlements.service.js';
import { SubscriptionSettingsController } from '../modules/subscription-settings/subscription-settings.http.js';
import { SubscriptionSettingsService } from '../modules/subscription-settings/subscription-settings.service.js';
import { ProOverviewController } from '../modules/pro-overview/pro-overview.http.js';
import { ProOverviewService } from '../modules/pro-overview/pro-overview.service.js';
import { ProAccessService } from '../modules/pro-overview/pro-access.service.js';
import { DiaryController } from '../modules/diary/diary.http.js';
import { DiaryService } from '../modules/diary/diary.service.js';
import { NutritionController } from '../modules/nutrition/nutrition.http.js';
import { NutritionService } from '../modules/nutrition/nutrition.service.js';
import { FinanceController } from '../modules/finance/finance.http.js';
import { FinanceService } from '../modules/finance/finance.service.js';
import { PricingController } from '../modules/finance/pricing.http.js';
import { PricingService } from '../modules/finance/pricing.service.js';
import { RecommendationsController } from '../modules/recommendations/recommendations.http.js';
import { RecommendationsService } from '../modules/recommendations/recommendations.service.js';
import { CommunityController } from '../modules/community/community.http.js';
import { CommunityService } from '../modules/community/community.service.js';
import {
    AdminAllergensController,
    AllergenReportController,
} from '../modules/allergen-intelligence/allergen-intelligence.http.js';
import { AllergenIntelligenceService } from '../modules/allergen-intelligence/allergen-intelligence.service.js';
import { FamilyController } from '../modules/family/family.http.js';
import { FamilyService } from '../modules/family/family.service.js';
import { AdminReadController } from '../modules/admin/admin-read.http.js';
import { AdminReadService } from '../modules/admin/admin-read.service.js';
import { AdminActionsController } from '../modules/admin-actions/admin-actions.http.js';
import { AdminActionsService } from '../modules/admin-actions/admin-actions.service.js';
import { AdminAuthController, AdminSessionGuard } from '../modules/admin-auth/admin-auth.http.js';
import { AdminAccessService } from '../modules/admin-auth/admin-access.service.js';
import { AdminNetworkGuard } from '../modules/admin-auth/admin-network.guard.js';
import { AdminNewsController } from '../modules/admin-news/admin-news.http.js';
import { AdminNewsService } from '../modules/admin-news/admin-news.service.js';
import { ScheduledNewsRunner } from '../modules/admin-news/scheduled-news.runner.js';
import { NewsPublicController } from '../modules/admin-news/news-public.http.js';
import { NewsPublicService } from '../modules/admin-news/news-public.service.js';
import { SearchController } from '../modules/search/search.http.js';
import { SearchService } from '../modules/search/search.service.js';
import { PrivacyController } from '../modules/privacy/privacy.http.js';
import { PrivacyService } from '../modules/privacy/privacy.service.js';
import { LegalConsentController, PublicLegalController } from '../modules/legal-consents/legal-consent.http.js';
import { LegalConsentService } from '../modules/legal-consents/legal-consent.service.js';
import {
    DatabaseLegalDocumentProvider,
    LEGAL_DOCUMENT_PROVIDER,
} from '../modules/legal-consents/legal-document.provider.js';
import { LegalConsentGuard } from '../modules/legal-consents/legal-consent.guard.js';
import { ExportsController } from '../modules/exports/exports.http.js';
import { ExportsService } from '../modules/exports/exports.service.js';
import {
    AccountLifecycleController,
    AdminAccountLifecycleController,
} from '../modules/account-lifecycle/account-lifecycle.http.js';
import { AccountLifecycleService } from '../modules/account-lifecycle/account-lifecycle.service.js';
import { CriticalReauthService } from '../modules/account-lifecycle/critical-reauth.service.js';
import { AiAppealsController } from '../modules/ai-appeals/ai-appeals.http.js';
import { AiAppealsService } from '../modules/ai-appeals/ai-appeals.service.js';
import {
    AchievementsController,
    ContentReleasesController,
} from '../modules/content-releases/content-releases.http.js';
import { ContentReleasesService } from '../modules/content-releases/content-releases.service.js';
import { AdminSupportController } from '../modules/admin-support/admin-support.http.js';
import { AdminSupportService } from '../modules/admin-support/admin-support.service.js';
import { NotificationCenterController } from '../modules/admin-notifications/notification-center.http.js';
import { NotificationCenterService } from '../modules/admin-notifications/notification-center.service.js';
import { AdminGovernanceController } from '../modules/admin-governance/admin-governance.http.js';
import { AdminGovernanceService } from '../modules/admin-governance/admin-governance.service.js';
import { OperationsWorkspaceController } from '../modules/admin-operations/operations.http.js';
import { OperationsWorkspaceService } from '../modules/admin-operations/operations.service.js';
import { OperationalMaintenanceService } from '../modules/admin-operations/operational-maintenance.service.js';
import { AdminContentController } from '../modules/admin-content/admin-content.http.js';
import { AdminContentService } from '../modules/admin-content/admin-content.service.js';
import { AdminBillingController } from '../modules/admin-billing/admin-billing.http.js';
import { AdminBillingService } from '../modules/admin-billing/admin-billing.service.js';
import { AdminReviewController } from '../modules/admin-review/admin-review.http.js';
import { AdminReviewService } from '../modules/admin-review/admin-review.service.js';
import { AdminRollbackRegistry } from '../modules/admin-review/admin-rollback.registry.js';
import { ModeratorController, ModeratorSessionGuard } from '../modules/moderator/moderator.http.js';
import { ModeratorService } from '../modules/moderator/moderator.service.js';
import { RecipeLifecycleService } from '../modules/recipe-lifecycle/recipe-lifecycle.service.js';
import { AccountController, MailboxController } from '../modules/account/account.http.js';
import { Module, type DynamicModule } from '@nestjs/common';
import { CookingLifecycleService } from '../modules/cooking/cooking-lifecycle.service.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DatabaseService } from '../infrastructure/database/database.service.js';
import { HealthController } from '../modules/health/health.controller.js';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from '../modules/auth/auth.service.js';
import { ProfilesController } from '../modules/profiles/profiles.http.js';
import { ProfilesService } from '../modules/profiles/profiles.service.js';
import { TelemetryController } from '../modules/telemetry/telemetry.http.js';
import { TelemetryRepository } from '../modules/telemetry/telemetry.repository.js';
import { TelemetryService } from '../modules/telemetry/telemetry.service.js';
import { AdminProviderTelemetry, AdminWorkerRuntimeSink } from '../modules/telemetry/runtime-telemetry.js';
import {
    AuthController,
    StaffAuthController,
    AuthCookies,
    CsrfGuard,
    UserSessionGuard,
    StaffSessionGuard,
} from '../modules/auth/auth.http.js';

@Module({})
export class AppModule {
    static configure(config: AppConfig): DynamicModule {
        return {
            module: AppModule,
            controllers: [
                RecipePolicyController,
                RecipeWorkspaceController,
                CookingController,
                CookingStatisticsController,
                ShoppingController,
                ReceiptsController,
                PurchasesController,
                MealPlanController,
                PortionsController,
                FamilyNotesController,
                FamilyChatController,
                PersonalizationController,
                NotificationsController,
                SupportController,
                AiController,
                AdminFreeAiController,
                RecipesController,
                PreservesController,
                InventoryController,
                InventoryIngestController,
                ProductsController,
                EntitlementsController,
                SubscriptionSettingsController,
                ProOverviewController,
                DiaryController,
                NutritionController,
                FinanceController,
                PricingController,
                RecommendationsController,
                CommunityController,
                AdminAllergensController,
                AllergenReportController,
                FamilyController,
                AdminNewsController,
                NewsPublicController,
                SearchController,
                PrivacyController,
                PublicLegalController,
                LegalConsentController,
                ExportsController,
                AccountLifecycleController,
                AdminAccountLifecycleController,
                AiAppealsController,
                ContentReleasesController,
                AchievementsController,
                AdminSupportController,
                NotificationCenterController,
                AdminGovernanceController,
                OperationsWorkspaceController,
                AdminContentController,
                AdminBillingController,
                AdminReviewController,
                ModeratorController,
                AdminAuthController,
                AdminReadController,
                AdminActionsController,
                AccountController,
                MailboxController,
                HealthController,
                AuthController,
                StaffAuthController,
                ProfilesController,
                TelemetryController,
            ],
            providers: [
                RecipePolicyService,
                RecipeWorkspaceService,
                RecipeLifecycleService,
                CookingService,
                CookingLifecycleService,
                CookingStatisticsPolicy,
                ShoppingService,
                ReceiptsService,
                PurchasesService,
                MealPlanService,
                FamilyNotesService,
                FamilyChatService,
                PersonalizationService,
                NotificationsService,
                SupportService,
                AiService,
                AiProvider,
                AiReconciliationService,
                DisabledPaymentProvider,
                { provide: PAYMENT_PROVIDER, useExisting: DisabledPaymentProvider },
                DisabledRefundProvider,
                { provide: REFUND_PROVIDER, useExisting: DisabledRefundProvider },
                PostgresPaymentRepository,
                { provide: PAYMENT_REPOSITORY, useExisting: PostgresPaymentRepository },
                PaymentApplicationService,
                DisabledObjectStorageProvider,
                DisabledKeyManagementProvider,
                DisabledMalwareScannerProvider,
                { provide: OBJECT_STORAGE_PROVIDER, useExisting: DisabledObjectStorageProvider },
                { provide: KEY_MANAGEMENT_PROVIDER, useExisting: DisabledKeyManagementProvider },
                { provide: MALWARE_SCANNER_PROVIDER, useExisting: DisabledMalwareScannerProvider },
                DisabledEmailDeliveryProvider,
                DisabledWebPushDeliveryProvider,
                DisabledAccountMailOutbox,
                { provide: EMAIL_DELIVERY_PROVIDER, useExisting: DisabledEmailDeliveryProvider },
                { provide: WEB_PUSH_DELIVERY_PROVIDER, useExisting: DisabledWebPushDeliveryProvider },
                { provide: ACCOUNT_MAIL_OUTBOX, useExisting: DisabledAccountMailOutbox },
                DisabledOcrProvider,
                { provide: OCR_PROVIDER, useExisting: DisabledOcrProvider },
                DisabledSecretProvider,
                { provide: SECRET_PROVIDER, useExisting: DisabledSecretProvider },
                AdminProviderTelemetry,
                AdminWorkerRuntimeSink,
                { provide: PROVIDER_TELEMETRY, useExisting: AdminProviderTelemetry },
                ProviderObserver,
                AdminFreeAiService,
                NotificationCenterService,
                OperationsWorkspaceService,
                OperationalMaintenanceService,
                AdminSupportService,
                AdminGovernanceService,
                AdminContentService,
                ModeratorService,
                RecipesService,
                PreservesService,
                InventoryService,
                InventoryIngestService,
                ProductsService,
                EntitlementsService,
                SubscriptionSettingsService,
                ProOverviewService,
                ProAccessService,
                DiaryService,
                NutritionService,
                FinanceService,
                PricingService,
                RecommendationsService,
                CommunityService,
                AllergenIntelligenceService,
                AdminNewsService,
                ScheduledNewsRunner,
                NewsPublicService,
                SearchService,
                PrivacyService,
                LegalConsentService,
                LegalConsentGuard,
                DatabaseLegalDocumentProvider,
                { provide: LEGAL_DOCUMENT_PROVIDER, useExisting: DatabaseLegalDocumentProvider },
                ExportsService,
                AccountLifecycleService,
                CriticalReauthService,
                AiAppealsService,
                ContentReleasesService,
                FamilyService,
                { provide: APP_CONFIG, useValue: config },
                DatabaseService,
                AuthService,
                AdminAccessService,
                AdminReadService,
                AdminActionsService,
                AdminBillingService,
                AdminReviewService,
                AdminRollbackRegistry,
                {
                    provide: RegistrationRiskPolicy,
                    useFactory: () => new RegistrationRiskPolicy(registrationRiskConfig(config), null),
                },
                AccountService,
                ProfilesService,
                TelemetryRepository,
                TelemetryService,
                AuthCookies,
                AdminSessionGuard,
                UserSessionGuard,
                StaffSessionGuard,
                ModeratorSessionGuard,
                { provide: APP_GUARD, useClass: AdminNetworkGuard },
                { provide: APP_GUARD, useClass: CsrfGuard },
            ],
        };
    }
}
