import {
    recipesListSchema,
    recipeResultSchema,
    recipePersonalSchema,
    recipeBookmarkResultSchema,
} from '../../modules/recipes/recipes.contracts.js';
import {
    preserveListSchema,
    preserveResultSchema,
    preserveConsumePreviewSchema,
    preserveHistorySchema,
    preserveRecipeBaseSchema,
    preserveQrResultSchema,
} from '../../modules/preserves/preserves.contracts.js';
import { recipePolicySchema } from '../../modules/recipe-policy/recipe-policy.contracts.js';
import {
    workspaceReportsSchema,
    workspaceReportDetailSchema,
    workspaceListSchema,
    workspaceResultSchema,
    workspaceCommunitySchema,
    workspaceCommunityMutationSchema,
} from '../../modules/recipe-workspace/recipe-workspace.contracts.js';
import {
    cookingListSchema,
    cookingAttemptSchema,
    cookingStockOptionsSchema,
    cookingStatisticsSchema,
    cookingReminderPreferencesSchema,
} from '../../modules/cooking/cooking.contracts.js';
import {
    shoppingListsSchema,
    shoppingListSchema,
    shoppingHistorySchema,
    shoppingPreviewSchema,
} from '../../modules/shopping/shopping.contracts.js';
import {
    purchaseDetailSchema,
    purchasePreviewSchema,
    purchaseResultSchema,
    receiptDuplicatesSchema,
    receiptCapabilitiesSchema,
    receiptResultSchema,
} from '../../modules/receipts/receipts.contracts.js';
import {
    planSchema,
    planChangePreviewResultSchema,
    planShoppingPreviewResultSchema,
    planShoppingCommitResultSchema,
    portionWorkspaceSchema,
    planAutomationPreviewResultSchema,
} from '../../modules/meal-plan/meal-plan.contracts.js';
import { accountOutputs, accountRoutes, securitySchema } from '../../modules/account/account.contracts.js';
import { z } from 'zod';
import {
    inventoryListSchema,
    inventoryResultSchema,
    inventoryLocationsSchema,
    inventoryLocationResultSchema,
    inventoryHistorySchema,
    inventoryImportResultSchema,
} from '../../modules/inventory/inventory.contracts.js';
import {
    productListSchema,
    productResultSchema,
    productReferenceSchema,
} from '../../modules/products/products.contracts.js';
import { importPreviewSchema, scanPreviewSchema } from '../../modules/inventory-ingest/ingest.contracts.js';
import { newsResultSchema } from '../../modules/admin-news/admin-news.contracts.js';
import {
    publicNewsDetailSchema,
    publicNewsListSchema,
    newsReadResultSchema,
} from '../../modules/admin-news/admin-news.contracts.js';
import { searchResultSchema } from '../../modules/search/search.contracts.js';
import { privacyStateSchema } from '../../modules/privacy/privacy.contracts.js';
import {
    consentHistorySchema,
    consentStateSchema,
    publicLegalManifestSchema,
} from '../../modules/legal-consents/legal-consent.contracts.js';
import {
    exportDownloadSchema,
    exportCreateResultSchema,
    exportListSchema,
    exportPreviewSchema,
} from '../../modules/exports/exports.contracts.js';
import {
    archiveResultSchema,
    deletionPreviewSchema,
    deletionRequestSchema,
    lifecycleStateSchema,
} from '../../modules/account-lifecycle/account-lifecycle.contracts.js';
import { criticalReauthResultSchema } from '../../modules/account-lifecycle/critical-reauth.contracts.js';
import { aiAppealDetailSchema, aiAppealsListSchema } from '../../modules/ai-appeals/ai-appeals.contracts.js';
import {
    authorAchievementsSchema,
    authorReputationSchema,
    publicReputationLevelsSchema,
    releaseDetailSchema,
    releaseHistorySchema,
    releaseListSchema,
    releaseSourcesSchema,
} from '../../modules/content-releases/content-releases.contracts.js';
import {
    governanceViewSchema,
    governanceResultSchema,
} from '../../modules/admin-governance/admin-governance.contracts.js';
import { operationsResultSchema } from '../../modules/admin-operations/operations.contracts.js';
import { contentResultSchema } from '../../modules/admin-content/admin-content.contracts.js';
import { billingViewSchema, billingResultSchema } from '../../modules/admin-billing/admin-billing.contracts.js';
import { reviewResultSchema } from '../../modules/admin-review/admin-review.contracts.js';
import { notificationCenterSchema } from '../../modules/admin-notifications/notification-center.contracts.js';
import {
    supportWorkspaceSchema,
    supportManagedResultSchema,
} from '../../modules/admin-support/admin-support.contracts.js';
import {
    adminPageSchema,
    adminDetailSchema,
    adminRelatedPageSchema,
} from '../../modules/admin/admin-read.contracts.js';
import {
    notificationSettingsSchema,
    supportCommandResultSchema,
    supportMessagesSchema,
} from '../../modules/admin-actions/admin-actions.contracts.js';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ownProfileSchema, publicProfileSchema } from '../../modules/profiles/profiles.schemas.js';
import {
    homeSchema,
    onboardingSchema,
    personalizationSchema,
    preferencesSchema,
} from '../../modules/personalization/personalization.contracts.js';
import {
    notificationListSchema,
    notificationMutationSchema,
    notificationPreferencesSchema,
} from '../../modules/notifications/notifications.contracts.js';
import { supportDetailSchema, supportListSchema, supportMetaSchema } from '../../modules/support/support.contracts.js';
import {
    aiBalanceSchema,
    aiCapabilitiesSchema,
    aiConversationSchema,
    aiFamilySharingSchema,
    aiHistorySchema,
    aiHistoryArchiveResultSchema,
    aiPreviewSchema,
    aiPurchaseSchema,
    aiRunSchema,
    aiTransferResultSchema,
} from '../../modules/ai/ai.contracts.js';
import {
    adminFreeAiGrantResultSchema,
    adminFreeAiViewSchema,
} from '../../modules/admin-free-ai/admin-free-ai.contracts.js';
import { entitlementSchema } from '../../modules/entitlements/entitlements.contracts.js';
import {
    combinationConsentResultSchema,
    combinationPreviewSchema,
    downgradePreviewSchema,
    planChangePreviewSchema,
    renewalPreviewSchema,
    subscriptionPreviewSchema,
    subscriptionSettingsSchema,
} from '../../modules/subscription-settings/subscription-settings.contracts.js';
import { proOverviewSchema } from '../../modules/pro-overview/pro-overview.contracts.js';
import {
    diaryDaySchema,
    diaryMediaCapabilitySchema,
    diaryPortionDecisionResultSchema,
    diaryResultSchema,
    diarySourcesSchema,
} from '../../modules/diary/diary.contracts.js';
import { nutritionAnalyticsSchema, nutritionSettingsSchema } from '../../modules/nutrition/nutrition.contracts.js';
import {
    financeBudgetListSchema,
    financeBudgetResultSchema,
    financeExpenseListSchema,
    financeExpenseResultSchema,
    financeOverviewSchema,
    financeAnalyticsSchema,
    financeCostEstimateSchema,
    financePriceCatalogSchema,
    financePriceListSchema,
    financePriceObservationResultSchema,
} from '../../modules/finance/finance.contracts.js';
import {
    familyContextSchema,
    familyInvitationListSchema,
    familyInvitationPreviewSchema,
    familyInvitationResultSchema,
    familyLeavePreviewSchema,
    familyLifecycleResultSchema,
    ownershipNoticeDismissResultSchema,
    ownershipNoticeSchema,
    ownershipWorkspaceSchema,
    ownershipTransferPreviewSchema,
    ownershipRequestDetailSchema,
    ownershipRequestResultSchema,
} from '../../modules/family/family.contracts.js';
import {
    familyNoteHistorySchema,
    familyNoteSchema,
    familyNotesSchema,
} from '../../modules/family-notes/family-notes.contracts.js';
import {
    familyChatDraftSchema,
    familyChatMutationSchema,
    familyChatSchema,
} from '../../modules/family-chat/family-chat.contracts.js';
import {
    authorFollowResultSchema,
    authorFollowingListSchema,
    recommendationEventResultSchema,
    recommendationsResultSchema,
} from '../../modules/recommendations/recommendations.contracts.js';
import { communityCommentsSchema, communityFeedSchema } from '../../modules/community/community.contracts.js';
import {
    allergenAdminDetailSchema,
    allergenAdminListSchema,
    allergenReportResultSchema,
    allergenSubjectListSchema,
} from '../../modules/allergen-intelligence/allergen-intelligence.contracts.js';
import {
    moderatorItemSchema,
    moderatorOverviewSchema,
    moderatorQueuePageSchema,
    moderatorSupportSchema,
} from '../../modules/moderator/moderator.contracts.js';
import { telemetryAcceptedSchema } from '../../modules/telemetry/telemetry.contracts.js';

const meta = z.strictObject({ requestId: z.uuid() });
export const principalSchema = z.strictObject({
    id: z.uuid(),
    displayName: z.string(),
    context: z.enum(['user', 'admin', 'moderator']),
    expiresAt: z.iso.datetime(),
    sessionId: z.uuid(),
});
export const responseDataSchemas = {
    ownProfile: z.strictObject({ profile: ownProfileSchema }),
    publicProfile: z.strictObject({ profile: publicProfileSchema }),
    health: z.strictObject({ status: z.literal('ok') }),
    csrf: z.strictObject({ token: z.string() }),
    user: z.strictObject({ user: principalSchema }),
    logout: z.strictObject({ loggedOut: z.literal(true) }),
    challenge: z.strictObject({
        status: z.literal('mfa_required'),
        challenge: z.string(),
        expiresAt: z.iso.datetime(),
        enrollment: z.strictObject({ secret: z.string(), uri: z.string() }).nullable(),
    }),
    verified: z.strictObject({ user: principalSchema, recoveryCodes: z.array(z.string()) }),
    adminVerified: z.strictObject({
        user: principalSchema,
        recoveryCodes: z.array(z.string()),
        unlockToken: z.string(),
    }),
    adminStatus: z.strictObject({
        user: principalSchema,
        status: z.enum(['locked', 'unlocked']),
        criticalUntil: z.iso.datetime().nullable(),
    }),
    adminUnlocked: z.strictObject({
        user: principalSchema,
        unlockToken: z.string(),
        criticalUntil: z.iso.datetime().nullable(),
    }),
    adminConfirmed: z.strictObject({ criticalUntil: z.iso.datetime() }),
    sessions: z.strictObject({
        sessions: z.array(
            z.strictObject({
                id: z.uuid(),
                context: z.enum(['user', 'admin', 'moderator']),
                authenticatedAt: z.iso.datetime(),
                expiresAt: z.iso.datetime(),
                current: z.boolean(),
            }),
        ),
    }),
    revoked: z.strictObject({ revokedCount: z.number().int().nonnegative() }),
};
export const errorEnvelopeSchema = z.strictObject({
    error: z.strictObject({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).nullable(),
    }),
    meta,
});
export const envelope = <T extends z.ZodType>(data: T) => z.strictObject({ data, meta });

export const createdResponseOperationIds = new Set([
    'FamilyController_create',
    'FamilyController_invite',
    'FamilyController_createOwnershipRequest',
    'FamilyNotesController_create',
    'FamilyChatController_send',
]);

export function documentResponses(document: OpenAPIObject): OpenAPIObject {
    const routes: Record<string, keyof typeof responseDataSchemas> = {
        '/api/v1/profile': 'ownProfile',
        '/api/v1/authors/{username}': 'publicProfile',
        '/health/live': 'health',
        '/health/ready': 'health',
        '/api/v1/auth/csrf': 'csrf',
        '/api/v1/admin/auth/csrf': 'csrf',
        '/api/v1/admin/auth/login': 'challenge',
        '/api/v1/admin/auth/mfa/verify': 'adminVerified',
        '/api/v1/admin/auth/status': 'adminStatus',
        '/api/v1/admin/auth/unlock': 'adminUnlocked',
        '/api/v1/admin/auth/critical-confirm': 'adminConfirmed',
        '/api/v1/admin/auth/me': 'user',
        '/api/v1/admin/auth/sessions': 'sessions',
        '/api/v1/admin/auth/sessions/revoke-others': 'revoked',
        '/api/v1/admin/auth/logout': 'logout',
        '/api/v1/auth/login': 'user',
        '/api/v1/auth/me': 'user',
        '/api/v1/auth/logout': 'logout',
        '/api/v1/staff/auth/login': 'challenge',
        '/api/v1/staff/auth/mfa/verify': 'verified',
        '/api/v1/staff/auth/me': 'user',
        '/api/v1/staff/auth/logout': 'logout',
        '/api/v1/auth/sessions': 'sessions',
        '/api/v1/staff/auth/sessions': 'sessions',
        '/api/v1/auth/sessions/revoke-others': 'revoked',
        '/api/v1/staff/auth/sessions/revoke-others': 'revoked',
    };
    const accountSchemas: Record<string, z.ZodType> = Object.fromEntries(
        Object.entries(accountOutputs).map(([key, value]) => [
            '/api/v1' + accountRoutes[key as keyof typeof accountRoutes],
            value,
        ]),
    );
    accountSchemas['/api/v1/auth/security'] = securitySchema;
    accountSchemas['/api/v1/telemetry/browser'] = telemetryAcceptedSchema;
    accountSchemas['/api/v1/admin/telemetry/browser'] = telemetryAcceptedSchema;
    accountSchemas['/api/v1/admin/news-workspace'] = newsResultSchema;
    accountSchemas['/api/v1/admin/billing/{section}/{id}'] = billingViewSchema;
    accountSchemas['/api/v1/admin/free-ai/users/{id}'] = adminFreeAiViewSchema;
    accountSchemas['/api/v1/admin/free-ai/users/{id}/grants'] = adminFreeAiGrantResultSchema;
    for (const suffix of ['', '/preview', '/prepare-export', '/apply-rollback'])
        accountSchemas[`/api/v1/admin/review-workspace/{section}/{id}${suffix}`] = reviewResultSchema;
    accountSchemas['/api/v1/admin/governance/{section}/{id}'] = governanceViewSchema;
    accountSchemas['/api/v1/admin/content-workspace/{section}/{id}'] = contentResultSchema;
    for (const suffix of ['moderate', 'compare', 'merge', 'not-duplicate'])
        accountSchemas[`/api/v1/admin/content-workspace/{section}/{id}/${suffix}`] = contentResultSchema;
    for (const suffix of ['inspect', 'preview', 'execute'])
        accountSchemas[`/api/v1/admin/operations-workspace/${suffix}`] = operationsResultSchema;
    for (const action of ['save', 'preview', 'launch', 'cancel', 'test'])
        accountSchemas[`/api/v1/admin/news-workspace/${action}`] = newsResultSchema;
    for (const suffix of ['', '/settings', '/read'])
        accountSchemas[`/api/v1/admin/notification-center${suffix}`] = notificationCenterSchema;
    accountSchemas['/api/v1/admin/support/{id}/workspace'] = supportWorkspaceSchema;
    accountSchemas['/api/v1/admin/support/{id}/manage'] = supportManagedResultSchema;
    accountSchemas['/api/v1/admin/support/create'] = supportManagedResultSchema;
    accountSchemas['/api/v1/admin/{section}/search'] = adminPageSchema;
    accountSchemas['/api/v1/admin/{section}/{id}'] = adminDetailSchema;
    accountSchemas['/api/v1/admin/{section}/{id}/related/{collection}/search'] = adminRelatedPageSchema;
    accountSchemas['/api/v1/admin/notification-preferences'] = notificationSettingsSchema;
    accountSchemas['/api/v1/admin/support/{id}/reply'] = supportCommandResultSchema;
    accountSchemas['/api/v1/admin/support/{id}/reopen'] = supportCommandResultSchema;
    accountSchemas['/api/v1/admin/support/{id}/messages/search'] = supportMessagesSchema;
    accountSchemas['/api/v1/auth/totp/login'] = responseDataSchemas.user;
    accountSchemas['/api/v1/auth/pin/login'] = responseDataSchemas.user;
    const domain: Record<string, z.ZodType> = {
        'GET /api/v1/legal/manifest': publicLegalManifestSchema,
        'GET /api/v1/settings/legal-consents': consentStateSchema,
        'GET /api/v1/settings/legal-consents/history': consentHistorySchema,
        'POST /api/v1/settings/legal-consents/{kind}/accept': consentStateSchema,
        'POST /api/v1/settings/legal-consents/{kind}/revoke': consentStateSchema,
        'GET /api/v1/admin/content-releases': releaseListSchema,
        'POST /api/v1/admin/content-releases': releaseDetailSchema,
        'GET /api/v1/admin/content-releases/history': releaseHistorySchema,
        'GET /api/v1/admin/content-releases/sources': releaseSourcesSchema,
        'GET /api/v1/admin/content-releases/{id}': releaseDetailSchema,
        'PUT /api/v1/admin/content-releases/{id}': releaseDetailSchema,
        'POST /api/v1/admin/content-releases/{id}/validate': releaseDetailSchema,
        'POST /api/v1/admin/content-releases/{id}/publish': releaseDetailSchema,
        'POST /api/v1/admin/content-releases/{id}/rollback': releaseDetailSchema,
        'POST /api/v1/admin/content-releases/{id}/edit': releaseDetailSchema,
        'GET /api/v1/reputation/levels': publicReputationLevelsSchema,
        'GET /api/v1/authors/{username}/achievements': authorAchievementsSchema,
        'GET /api/v1/authors/{username}/reputation': authorReputationSchema,
        'GET /api/v1/news': publicNewsListSchema,
        'GET /api/v1/news/{id}': publicNewsDetailSchema,
        'POST /api/v1/news/{id}/read': newsReadResultSchema,
        'GET /api/v1/search': searchResultSchema,
        'GET /api/v1/settings/privacy': privacyStateSchema,
        'PUT /api/v1/settings/privacy/ai-access': privacyStateSchema,
        'GET /api/v1/exports': exportListSchema,
        'POST /api/v1/exports/preview': exportPreviewSchema,
        'POST /api/v1/exports': exportCreateResultSchema,
        'GET /api/v1/exports/{id}/download-content': exportDownloadSchema,
        'POST /api/v1/account/critical-reauth': criticalReauthResultSchema,
        'GET /api/v1/account/lifecycle': lifecycleStateSchema,
        'POST /api/v1/account/archive': archiveResultSchema,
        'GET /api/v1/account/deletion/preview': deletionPreviewSchema,
        'POST /api/v1/account/deletion': deletionRequestSchema,
        'POST /api/v1/account/deletion/cancel': deletionRequestSchema,
        'POST /api/v1/account/deletion/finalize': deletionRequestSchema,
        'POST /api/v1/admin/account-deletions/{id}/review': deletionRequestSchema,
        'GET /api/v1/ai/appeals': aiAppealsListSchema,
        'POST /api/v1/ai/appeals': aiAppealDetailSchema,
        'GET /api/v1/ai/appeals/{id}': aiAppealDetailSchema,
        'GET /api/v1/entitlements': entitlementSchema,
        'GET /api/v1/settings/subscription': subscriptionSettingsSchema,
        'GET /api/v1/pro/overview': proOverviewSchema,
        'GET /api/v1/diary': diaryDaySchema,
        'GET /api/v1/diary/sources': diarySourcesSchema,
        'POST /api/v1/diary': diaryResultSchema,
        'PUT /api/v1/diary/{id}': diaryResultSchema,
        'POST /api/v1/diary/{id}/archive': diaryResultSchema,
        'POST /api/v1/diary/{id}/media': diaryMediaCapabilitySchema,
        'POST /api/v1/diary/portions/{id}/decision': diaryPortionDecisionResultSchema,
        'GET /api/v1/nutrition/settings': nutritionSettingsSchema,
        'PUT /api/v1/nutrition/profile': nutritionSettingsSchema,
        'POST /api/v1/nutrition/targets': nutritionSettingsSchema,
        'GET /api/v1/nutrition/analytics': nutritionAnalyticsSchema,
        'GET /api/v1/finance/overview': financeOverviewSchema,
        'GET /api/v1/finance/analytics': financeAnalyticsSchema,
        'GET /api/v1/finance/expenses': financeExpenseListSchema,
        'POST /api/v1/finance/expenses': financeExpenseResultSchema,
        'GET /api/v1/finance/expenses/{id}': financeExpenseResultSchema,
        'PUT /api/v1/finance/expenses/{id}': financeExpenseResultSchema,
        'GET /api/v1/finance/budgets': financeBudgetListSchema,
        'POST /api/v1/finance/budgets': financeBudgetResultSchema,
        'PUT /api/v1/finance/budgets/{id}': financeBudgetResultSchema,
        'GET /api/v1/finance/prices/catalog': financePriceCatalogSchema,
        'GET /api/v1/finance/prices': financePriceListSchema,
        'POST /api/v1/finance/prices': financePriceObservationResultSchema,
        'GET /api/v1/finance/costs/recipes/{id}': financeCostEstimateSchema,
        'GET /api/v1/finance/costs/shopping-lists/{id}': financeCostEstimateSchema,
        'GET /api/v1/finance/costs/meal-plans/{id}': financeCostEstimateSchema,
        'POST /api/v1/settings/subscription/trial/activate': subscriptionSettingsSchema,
        'POST /api/v1/settings/subscription/plus/preview': subscriptionPreviewSchema,
        'POST /api/v1/settings/subscription/plus/commit': subscriptionSettingsSchema,
        'POST /api/v1/settings/subscription/plan/preview': planChangePreviewSchema,
        'POST /api/v1/settings/subscription/plan/commit': subscriptionSettingsSchema,
        'POST /api/v1/settings/subscription/renewal/preview': renewalPreviewSchema,
        'POST /api/v1/settings/subscription/renewal/commit': subscriptionSettingsSchema,
        'POST /api/v1/settings/subscription/combination/preview': combinationPreviewSchema,
        'POST /api/v1/settings/subscription/combination/consent': combinationConsentResultSchema,
        'POST /api/v1/settings/subscription/downgrade/preview': downgradePreviewSchema,
        'POST /api/v1/settings/subscription/downgrade/commit': subscriptionSettingsSchema,
        'GET /api/v1/family': familyContextSchema,
        'POST /api/v1/family': familyContextSchema,
        'GET /api/v1/family/leave-preview': familyLeavePreviewSchema,
        'POST /api/v1/family/leave': familyLifecycleResultSchema,
        'POST /api/v1/family/members/{membershipId}/remove': familyContextSchema,
        'GET /api/v1/family/ownership-notice': ownershipNoticeSchema,
        'POST /api/v1/family/ownership-notice/dismiss': ownershipNoticeDismissResultSchema,
        'GET /api/v1/family/ownership': ownershipWorkspaceSchema,
        'POST /api/v1/family/ownership/preview': ownershipTransferPreviewSchema,
        'POST /api/v1/family/ownership/requests': ownershipRequestDetailSchema,
        'GET /api/v1/family/ownership/requests/{token}': ownershipRequestDetailSchema,
        'POST /api/v1/family/ownership/requests/{token}/accept': ownershipRequestResultSchema,
        'POST /api/v1/family/ownership/requests/{token}/decline': ownershipRequestResultSchema,
        'POST /api/v1/family/ownership/requests/{token}/cancel': ownershipRequestResultSchema,
        'GET /api/v1/family/invitations': familyInvitationListSchema,
        'POST /api/v1/family/invitations': familyInvitationResultSchema,
        'POST /api/v1/family/invitations/{invitationId}/approve': familyInvitationResultSchema,
        'POST /api/v1/family/invitations/{invitationId}/cancel': familyInvitationResultSchema,
        'GET /api/v1/family/invitation-preview': familyInvitationPreviewSchema,
        'POST /api/v1/family/invitation-accept': familyContextSchema,
        'GET /api/v1/recipe-workspace': workspaceListSchema,
        'GET /api/v1/recipe-workspace/reports': workspaceReportsSchema,
        'GET /api/v1/recipe-workspace/reports/{id}': workspaceReportDetailSchema,
        'POST /api/v1/recipe-workspace': workspaceResultSchema,
        'GET /api/v1/recipe-workspace/{id}': workspaceResultSchema,
        'PUT /api/v1/recipe-workspace/{id}': workspaceResultSchema,
        'POST /api/v1/recipe-workspace/{id}/archive': workspaceResultSchema,
        'POST /api/v1/recipe-workspace/{id}/restore': workspaceResultSchema,
        'POST /api/v1/recipe-workspace/{id}/submit': workspaceResultSchema,
        'POST /api/v1/recipe-workspace/{id}/rollback': workspaceResultSchema,
        'POST /api/v1/recipe-workspace/{id}/variant': workspaceResultSchema,
        'GET /api/v1/recipe-workspace/{id}/community': workspaceCommunitySchema,
        'POST /api/v1/recipe-workspace/{id}/rating': workspaceCommunityMutationSchema,
        'POST /api/v1/recipe-workspace/{id}/comments': workspaceCommunityMutationSchema,
        'PATCH /api/v1/recipe-workspace/{id}/comments/{commentId}': workspaceCommunityMutationSchema,
        'POST /api/v1/recipe-workspace/{id}/comments/{commentId}/remove': workspaceCommunityMutationSchema,
        'POST /api/v1/recipe-workspace/{id}/reports': workspaceCommunityMutationSchema,
        'GET /api/v1/cooking-attempts': cookingListSchema,
        'GET /api/v1/cooking-attempts/reminder-preferences': cookingReminderPreferencesSchema,
        'POST /api/v1/cooking-attempts/reminder-preferences': cookingReminderPreferencesSchema,
        'GET /api/v1/recipes/{id}/cooking-statistics': cookingStatisticsSchema,
        'GET /api/v1/cooking-attempts/stock-options': cookingStockOptionsSchema,
        'POST /api/v1/cooking-attempts': cookingAttemptSchema,
        'GET /api/v1/cooking-attempts/{id}': cookingAttemptSchema,
        'POST /api/v1/cooking-attempts/{id}/progress': cookingAttemptSchema,
        'POST /api/v1/cooking-attempts/{id}/finalize': cookingAttemptSchema,
        'GET /api/v1/shopping-lists': shoppingListsSchema,
        'POST /api/v1/shopping-lists': shoppingListSchema,
        'GET /api/v1/shopping-lists/recipe-preview': shoppingPreviewSchema,
        'GET /api/v1/shopping-lists/{id}': shoppingListSchema,
        'GET /api/v1/shopping-lists/{id}/history': shoppingHistorySchema,
        'POST /api/v1/shopping-lists/{id}/items': shoppingListSchema,
        'POST /api/v1/shopping-lists/{id}/items/{itemId}': shoppingListSchema,
        'POST /api/v1/shopping-lists/{id}/command': shoppingListSchema,
        'POST /api/v1/shopping-lists/{id}/reorder': shoppingListSchema,
        'POST /api/v1/shopping-lists/{id}/purchase-preview': purchasePreviewSchema,
        'POST /api/v1/shopping-lists/{id}/purchase-commit': purchaseResultSchema,
        'GET /api/v1/receipts/capabilities': receiptCapabilitiesSchema,
        'GET /api/v1/receipts/{id}': receiptResultSchema,
        'POST /api/v1/receipts': receiptResultSchema,
        'POST /api/v1/receipts/{id}/edit': receiptResultSchema,
        'POST /api/v1/receipts/{id}/intake-preview': purchasePreviewSchema,
        'POST /api/v1/receipts/{id}/commit': receiptResultSchema,
        'GET /api/v1/receipts/{id}/duplicates': receiptDuplicatesSchema,
        'POST /api/v1/receipts/{id}/link-purchase': receiptResultSchema,
        'GET /api/v1/purchases/{id}': purchaseDetailSchema,
        'POST /api/v1/purchases/{id}/resolve-preview': purchasePreviewSchema,
        'POST /api/v1/purchases/{id}/resolve-commit': purchaseDetailSchema,
        'GET /api/v1/meal-plan': planSchema,
        'POST /api/v1/meal-plan/change-preview': planChangePreviewResultSchema,
        'POST /api/v1/meal-plan/change-commit': planSchema,
        'POST /api/v1/meal-plan/shopping-preview': planShoppingPreviewResultSchema,
        'POST /api/v1/meal-plan/shopping-commit': planShoppingCommitResultSchema,
        'POST /api/v1/meal-plan/automation-preview': planAutomationPreviewResultSchema,
        'POST /api/v1/meal-plan/automation-commit': planSchema,
        'GET /api/v1/portions': portionWorkspaceSchema,
        'POST /api/v1/portions/assign': portionWorkspaceSchema,
        'POST /api/v1/portions/{id}/decision': portionWorkspaceSchema,
        'GET /api/v1/family/notes': familyNotesSchema,
        'POST /api/v1/family/notes': familyNoteSchema,
        'GET /api/v1/family/notes/{id}': familyNoteSchema,
        'PUT /api/v1/family/notes/{id}': familyNoteSchema,
        'POST /api/v1/family/notes/{id}/archive': familyNoteSchema,
        'POST /api/v1/family/notes/{id}/items/{itemId}/toggle': familyNoteSchema,
        'GET /api/v1/family/notes/{id}/history': familyNoteHistorySchema,
        'GET /api/v1/family/chat': familyChatSchema,
        'POST /api/v1/family/chat/messages': familyChatMutationSchema,
        'PUT /api/v1/family/chat/messages/{id}': familyChatMutationSchema,
        'POST /api/v1/family/chat/messages/{id}/remove': familyChatMutationSchema,
        'POST /api/v1/family/chat/messages/{id}/hide': familyChatMutationSchema,
        'POST /api/v1/family/chat/messages/{id}/reaction': familyChatMutationSchema,
        'POST /api/v1/family/chat/messages/{id}/pin': familyChatMutationSchema,
        'PUT /api/v1/family/chat/draft': familyChatDraftSchema,
        'POST /api/v1/family/chat/read': familyChatMutationSchema,
        'GET /api/v1/recipe-policy': recipePolicySchema,
        'GET /api/v1/admin/settings/recipe-policy': recipePolicySchema,
        'PUT /api/v1/admin/settings/recipe-policy': recipePolicySchema,
        'GET /api/v1/recipes': recipesListSchema,
        'GET /api/v1/recipes/{id}': recipeResultSchema,
        'GET /api/v1/recipes/{id}/personal': recipePersonalSchema,
        'POST /api/v1/recipes/{id}/bookmark': recipeBookmarkResultSchema,
        'GET /api/v1/preserves': preserveListSchema,
        'POST /api/v1/preserves': preserveResultSchema,
        'GET /api/v1/preserves/{id}': preserveResultSchema,
        'GET /api/v1/preserves/{id}/qr-label': preserveQrResultSchema,
        'POST /api/v1/preserves/{id}/qr-label': preserveQrResultSchema,
        'POST /api/v1/preserves/{id}/edit': preserveResultSchema,
        'POST /api/v1/preserves/{id}/archive': preserveResultSchema,
        'POST /api/v1/preserves/{id}/restore': preserveResultSchema,
        'POST /api/v1/preserves/{id}/containers/{containerId}/open': preserveResultSchema,
        'POST /api/v1/preserves/{id}/containers/{containerId}/quantity': preserveResultSchema,
        'POST /api/v1/preserves/{id}/consume-preview': preserveConsumePreviewSchema,
        'POST /api/v1/preserves/{id}/consume': preserveResultSchema,
        'POST /api/v1/preserves/{id}/recipe-base': preserveRecipeBaseSchema,
        'GET /api/v1/preserves/{id}/history': preserveHistorySchema,
        'GET /api/v1/inventory': inventoryListSchema,
        'POST /api/v1/inventory': inventoryResultSchema,
        'GET /api/v1/inventory/{id}': inventoryResultSchema,
        'POST /api/v1/inventory/{id}/command': inventoryResultSchema,
        'GET /api/v1/inventory-locations': inventoryLocationsSchema,
        'POST /api/v1/inventory-locations': inventoryLocationResultSchema,
        'GET /api/v1/inventory-history': inventoryHistorySchema,
        'POST /api/v1/inventory/import/commit': inventoryImportResultSchema,
        'GET /api/v1/products': productListSchema,
        'GET /api/v1/products/{id}': productResultSchema,
        'GET /api/v1/products/reference': productReferenceSchema,
        'POST /api/v1/products/proposals': productResultSchema,
        'POST /api/v1/inventory/ingest/import': importPreviewSchema,
        'POST /api/v1/inventory/ingest/scan': scanPreviewSchema,
        'GET /api/v1/home': homeSchema,
        'GET /api/v1/recommendations': recommendationsResultSchema,
        'POST /api/v1/recommendations/events': recommendationEventResultSchema,
        'GET /api/v1/community': communityFeedSchema,
        'GET /api/v1/community/recipes/{id}/comments': communityCommentsSchema,
        'GET /api/v1/authors/{username}/follow': authorFollowResultSchema,
        'PUT /api/v1/authors/{username}/follow': authorFollowResultSchema,
        'GET /api/v1/profile/following': authorFollowingListSchema,
        'GET /api/v1/admin/allergens': allergenAdminListSchema,
        'GET /api/v1/admin/allergens/subjects': allergenSubjectListSchema,
        'GET /api/v1/admin/allergens/{code}': allergenAdminDetailSchema,
        'POST /api/v1/admin/allergens/{code}/mappings': allergenAdminDetailSchema,
        'PUT /api/v1/admin/allergens/{code}/icon': allergenAdminDetailSchema,
        'POST /api/v1/admin/allergens/{code}/icon/upload': allergenAdminDetailSchema,
        'POST /api/v1/allergens/reports': allergenReportResultSchema,
        'GET /api/v1/moderator/overview': moderatorOverviewSchema,
        'GET /api/v1/moderator/queues/{queue}': moderatorQueuePageSchema,
        'GET /api/v1/moderator/items/{id}': moderatorItemSchema,
        'POST /api/v1/moderator/items/{id}/claim': moderatorItemSchema,
        'POST /api/v1/moderator/items/{id}/skip': moderatorItemSchema,
        'POST /api/v1/moderator/items/{id}/decision': moderatorItemSchema,
        'GET /api/v1/moderator/support/{id}': moderatorSupportSchema,
        'POST /api/v1/moderator/support/{id}/reply': moderatorSupportSchema,
        'POST /api/v1/moderator/support/{id}/reopen': moderatorSupportSchema,
        'GET /api/v1/personalization': personalizationSchema,
        'PUT /api/v1/personalization/onboarding': onboardingSchema,
        'PUT /api/v1/personalization/preferences': preferencesSchema,
        'GET /api/v1/notifications': notificationListSchema,
        'POST /api/v1/notifications/{id}/read': notificationMutationSchema,
        'POST /api/v1/notifications/read-all': notificationMutationSchema,
        'GET /api/v1/notification-preferences': notificationPreferencesSchema,
        'PUT /api/v1/notification-preferences': notificationPreferencesSchema,
        'GET /api/v1/support/meta': supportMetaSchema,
        'GET /api/v1/support': supportListSchema,
        'POST /api/v1/support': supportDetailSchema,
        'GET /api/v1/support/{id}': supportDetailSchema,
        'POST /api/v1/support/{id}/reply': supportDetailSchema,
        'PATCH /api/v1/support/{id}/messages/{messageId}': supportDetailSchema,
        'POST /api/v1/support/{id}/close': supportDetailSchema,
        'POST /api/v1/support/{id}/reopen': supportDetailSchema,
        'GET /api/v1/ai/capabilities': aiCapabilitiesSchema,
        'GET /api/v1/ai/balance': aiBalanceSchema,
        'GET /api/v1/ai/history': aiHistorySchema,
        'PUT /api/v1/ai/history/{id}/archive': aiHistoryArchiveResultSchema,
        'GET /api/v1/ai/family-sharing': aiFamilySharingSchema,
        'POST /api/v1/ai/transfers': aiTransferResultSchema,
        'POST /api/v1/ai/transfers/{id}/decision': aiTransferResultSchema,
        'POST /api/v1/ai/preview': aiPreviewSchema,
        'POST /api/v1/ai/run': aiRunSchema,
        'GET /api/v1/ai/tasks/{id}': aiConversationSchema,
        'POST /api/v1/ai/tasks/{id}/messages': aiConversationSchema,
        'POST /api/v1/ai/package/purchase': aiPurchaseSchema,
    };
    type Schema = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string];
    const toSchema = (value: z.ZodType) => z.toJSONSchema(value, { reused: 'inline', target: 'openapi-3.0' }) as Schema;
    for (const [path, item] of Object.entries(document.paths)) {
        for (const method of ['get', 'post', 'put', 'patch'] as const) {
            const operation = item[method];
            if (!operation) continue;
            const key = routes[path];
            const domainResponse = domain[`${method.toUpperCase()} ${path}`];
            if (!key && !accountSchemas[path] && !domainResponse) throw new Error(`Undocumented response: ${path}`);
            const successStatus = createdResponseOperationIds.has(operation.operationId ?? '') ? '201' : '200';
            operation.responses = {
                [successStatus]: {
                    description: successStatus === '201' ? 'Created' : 'Success',
                    content: {
                        'application/json': {
                            schema: toSchema(
                                envelope(
                                    domainResponse ??
                                        (path === '/api/v1/admin/governance/{section}/{id}' && method === 'post'
                                            ? governanceResultSchema
                                            : path === '/api/v1/admin/billing/{section}/{id}' && method === 'post'
                                              ? billingResultSchema
                                              : (accountSchemas[path] ?? responseDataSchemas[key!])),
                                ),
                            ),
                        },
                    },
                },
            };
            for (const status of [
                '400',
                '401',
                '403',
                '404',
                '408',
                '409',
                '412',
                '413',
                '415',
                '422',
                '428',
                '429',
                '500',
                '503',
            ])
                operation.responses[status] = {
                    description: 'Error envelope',
                    content: { 'application/json': { schema: toSchema(errorEnvelopeSchema) } },
                };
            if (method !== 'get')
                operation.parameters = [
                    ...(operation.parameters ?? []),
                    { in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } },
                ];
        }
    }
    return document;
}
