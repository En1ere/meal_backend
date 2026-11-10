import { AdminNetworkGuard } from '../modules/admin-auth/public.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './config.js';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from '../modules/auth/auth.http.js';
import { CoreRuntimeModule } from './core-runtime.module.js';
import { CatalogRecipesModule } from '../contexts/catalog-recipes/catalog-recipes.module.js';
import { EntitlementsCapabilityModule } from '../contexts/household-entitlements/entitlements-capability.module.js';
import { InventoryCapabilityModule } from '../contexts/inventory-commerce/inventory-capability.module.js';
import { ProductsCapabilityModule } from '../contexts/catalog-recipes/products-capability.module.js';
import { RecommendationsCapabilityModule } from '../contexts/planning-health/recommendations-capability.module.js';
import { AllergenIntelligenceCapabilityModule } from '../contexts/catalog-recipes/allergen-intelligence-capability.module.js';
import { RecipesCapabilityModule } from '../contexts/catalog-recipes/recipes-capability.module.js';
import { PreservesCapabilityModule } from '../contexts/catalog-recipes/preserves-capability.module.js';
import { TelemetryCapabilityModule } from '../contexts/platform-operations/telemetry-capability.module.js';
import { OperationalRuntimeCapabilityModule } from '../contexts/platform-operations/operational-runtime-capability.module.js';
import { LegalConsentsCapabilityModule } from '../contexts/identity-access/legal-consents-capability.module.js';
import { ContentReleasesCapabilityModule } from '../contexts/community-content/content-releases-capability.module.js';
import { CookingCapabilityModule } from '../contexts/catalog-recipes/cooking-capability.module.js';
import { ShoppingCapabilityModule } from '../contexts/inventory-commerce/shopping-capability.module.js';
import { SearchCapabilityModule } from '../contexts/catalog-recipes/search-capability.module.js';
import { ReceiptsCapabilityModule } from '../contexts/inventory-commerce/receipts-capability.module.js';
import { DiaryCapabilityModule } from '../contexts/planning-health/diary-capability.module.js';
import { MealPlanCapabilityModule } from '../contexts/planning-health/meal-plan-capability.module.js';
import { PrivacyCapabilityModule } from '../contexts/identity-access/privacy-capability.module.js';
import { SupportCapabilityModule } from '../contexts/community-content/support-capability.module.js';
import { CommunityCapabilityModule } from '../contexts/community-content/community-capability.module.js';
import { AiAppealsCapabilityModule } from '../contexts/community-content/ai-appeals-capability.module.js';
import { AdminSupportCapabilityModule } from '../contexts/community-content/admin-support-capability.module.js';
import { HealthCapabilityModule } from '../contexts/platform-operations/health-capability.module.js';
import { AdminNotificationsCapabilityModule } from '../contexts/platform-operations/admin-notifications-capability.module.js';
import { AdminActionsCapabilityModule } from '../contexts/platform-operations/admin-actions-capability.module.js';
import { ProfilesCapabilityModule } from '../contexts/identity-access/profiles-capability.module.js';
import { AdminFreeAiCapabilityModule } from '../contexts/integrations/admin-free-ai-capability.module.js';
import { FamilyNotesCapabilityModule } from '../contexts/household-entitlements/family-notes-capability.module.js';
import { OcrCapabilityModule } from '../contexts/integrations/ocr-capability.module.js';
import { SecretProviderCapabilityModule } from '../contexts/integrations/secret-provider-capability.module.js';
import { ProviderObservationCapabilityModule } from '../contexts/integrations/provider-observation-capability.module.js';
import { PersonalizationCapabilityModule } from '../contexts/planning-health/personalization-capability.module.js';
import { FamilyChatCapabilityModule } from '../contexts/household-entitlements/family-chat-capability.module.js';
import { NutritionCapabilityModule } from '../contexts/planning-health/nutrition-capability.module.js';
import { InventoryIngestCapabilityModule } from '../contexts/inventory-commerce/inventory-ingest-capability.module.js';
import { AdminOperationsCapabilityModule } from '../contexts/platform-operations/admin-operations-capability.module.js';
import { CriticalReauthCapabilityModule } from '../contexts/identity-access/critical-reauth-capability.module.js';
import { ExportsCapabilityModule } from '../contexts/identity-access/exports-capability.module.js';
import { AdminGovernanceCapabilityModule } from '../contexts/platform-operations/admin-governance-capability.module.js';
import { AccountLifecycleCapabilityModule } from '../contexts/identity-access/account-lifecycle-capability.module.js';
import { RecipeWorkspaceCapabilityModule } from '../contexts/catalog-recipes/recipe-workspace-capability.module.js';
import { AdminAuthCapabilityModule } from '../contexts/identity-access/admin-auth-capability.module.js';
import { AdminAcceptanceTestsCapabilityModule } from '../contexts/platform-operations/admin-acceptance-tests-capability.module.js';
import { NotificationsCapabilityModule } from '../contexts/integrations/notifications-capability.module.js';
import { AdminReadBoundaryCapabilityModule } from '../contexts/identity-access/admin-read-boundary-capability.module.js';
import { AdminObservabilityCapabilityModule } from '../contexts/platform-operations/admin-observability-capability.module.js';
import { AdminAiCapabilityModule } from '../contexts/platform-operations/admin-ai-capability.module.js';
import { AdminContentCapabilityModule } from '../contexts/community-content/admin-content-capability.module.js';
import { AdminReadCapabilityModule } from '../contexts/identity-access/admin-read-capability.module.js';
import { AdminRuntimeSettingsCapabilityModule } from '../contexts/platform-operations/admin-runtime-settings-capability.module.js';
import { AdminReviewCapabilityModule } from '../contexts/community-content/admin-review-capability.module.js';
import { ModeratorCapabilityModule } from '../contexts/community-content/moderator-capability.module.js';
import { PricingCapabilityModule } from '../contexts/inventory-commerce/pricing-capability.module.js';
import { FinanceCapabilityModule } from '../contexts/inventory-commerce/finance-capability.module.js';
import { SubscriptionSettingsCapabilityModule } from '../contexts/household-entitlements/subscription-settings-capability.module.js';
import { FamilyCapabilityModule } from '../contexts/household-entitlements/family-capability.module.js';
import { AiCapabilityModule } from '../contexts/integrations/ai-capability.module.js';
import { AiMealPlanCapabilityModule } from '../contexts/integrations/ai-meal-plan-capability.module.js';
import { ProOverviewCapabilityModule } from '../contexts/household-entitlements/pro-overview-capability.module.js';
import { AdminBillingCapabilityModule } from '../contexts/inventory-commerce/admin-billing-capability.module.js';
import { AdminNewsCapabilityModule } from '../contexts/community-content/admin-news-capability.module.js';
import { RegistrationRiskCapabilityModule } from '../contexts/identity-access/registration-risk-capability.module.js';
import { AccountMailOutboxCapabilityModule } from '../contexts/identity-access/account-mail-outbox-capability.module.js';
import { AccountServiceCapabilityModule } from '../contexts/identity-access/account-service-capability.module.js';
import { AccountHttpCapabilityModule } from '../contexts/identity-access/account-http-capability.module.js';
import { UserAuthHttpCapabilityModule } from '../contexts/identity-access/user-auth-http-capability.module.js';
import { StaffAuthHttpCapabilityModule } from '../contexts/identity-access/staff-auth-http-capability.module.js';
import { MediaStorageCapabilityModule } from '../contexts/integrations/media-storage-capability.module.js';
import { ObjectStorageProviderCapabilityModule } from '../contexts/integrations/object-storage-provider-capability.module.js';
import { KeyManagementProviderCapabilityModule } from '../contexts/integrations/key-management-provider-capability.module.js';
import { MalwareScannerProviderCapabilityModule } from '../contexts/integrations/malware-scanner-provider-capability.module.js';
import { EmailDeliveryProviderCapabilityModule } from '../contexts/integrations/email-delivery-provider-capability.module.js';
import { WebPushDeliveryProviderCapabilityModule } from '../contexts/integrations/web-push-delivery-provider-capability.module.js';

@Module({})
export class AppModule {
    static configure(config: AppConfig): DynamicModule {
        return {
            module: AppModule,
            imports: [
                CoreRuntimeModule.configure(config),
                CatalogRecipesModule,
                EntitlementsCapabilityModule,
                InventoryCapabilityModule,
                ProductsCapabilityModule,
                RecommendationsCapabilityModule,
                AllergenIntelligenceCapabilityModule,
                RecipesCapabilityModule,
                PreservesCapabilityModule,
                TelemetryCapabilityModule,
                OperationalRuntimeCapabilityModule,
                LegalConsentsCapabilityModule,
                ContentReleasesCapabilityModule,
                CookingCapabilityModule,
                ShoppingCapabilityModule,
                SearchCapabilityModule,
                ReceiptsCapabilityModule,
                DiaryCapabilityModule,
                MealPlanCapabilityModule,
                PrivacyCapabilityModule,
                SupportCapabilityModule,
                CommunityCapabilityModule,
                AiAppealsCapabilityModule,
                AdminSupportCapabilityModule,
                HealthCapabilityModule,
                AdminNotificationsCapabilityModule,
                AdminActionsCapabilityModule,
                ProfilesCapabilityModule,
                AdminFreeAiCapabilityModule,
                FamilyNotesCapabilityModule,
                OcrCapabilityModule,
                SecretProviderCapabilityModule,
                ProviderObservationCapabilityModule,
                PersonalizationCapabilityModule,
                FamilyChatCapabilityModule,
                NutritionCapabilityModule,
                InventoryIngestCapabilityModule,
                AdminOperationsCapabilityModule,
                CriticalReauthCapabilityModule,
                ExportsCapabilityModule,
                AdminGovernanceCapabilityModule,
                AccountLifecycleCapabilityModule,
                RecipeWorkspaceCapabilityModule,
                AdminAuthCapabilityModule,
                AdminAcceptanceTestsCapabilityModule,
                NotificationsCapabilityModule,
                AdminReadBoundaryCapabilityModule,
                AdminObservabilityCapabilityModule,
                AdminAiCapabilityModule,
                AdminContentCapabilityModule,
                AdminReadCapabilityModule,
                AdminRuntimeSettingsCapabilityModule,
                AdminReviewCapabilityModule,
                ModeratorCapabilityModule,
                PricingCapabilityModule,
                FinanceCapabilityModule,
                SubscriptionSettingsCapabilityModule,
                FamilyCapabilityModule,
                AiCapabilityModule,
                AiMealPlanCapabilityModule,
                ProOverviewCapabilityModule,
                AdminBillingCapabilityModule,
                AdminNewsCapabilityModule,
                RegistrationRiskCapabilityModule,
                AccountMailOutboxCapabilityModule,
                AccountServiceCapabilityModule,
                AccountHttpCapabilityModule,
                UserAuthHttpCapabilityModule,
                StaffAuthHttpCapabilityModule,
                MediaStorageCapabilityModule,
                ObjectStorageProviderCapabilityModule,
                KeyManagementProviderCapabilityModule,
                MalwareScannerProviderCapabilityModule,
                EmailDeliveryProviderCapabilityModule,
                WebPushDeliveryProviderCapabilityModule,
            ],
            controllers: [],
            providers: [
                { provide: APP_GUARD, useClass: AdminNetworkGuard },
                { provide: APP_GUARD, useClass: CsrfGuard },
            ],
        };
    }
}
