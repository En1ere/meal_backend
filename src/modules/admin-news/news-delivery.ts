import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import type { NewsContent } from './admin-news.contracts.js';

export type NewsDb = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export const marketingDeliveryAllowed = (category: NewsContent['category'], hasConsent: boolean) =>
    category !== 'marketing' || hasConsent;

export async function resolveNewsAudience(
    content: NewsContent,
    db: NewsDb,
    entitlements: EntitlementsService,
    legalConsents: LegalConsentService,
) {
    const users = await sql<{
        id: string;
        registeredAt: Date;
        activeAt: Date | null;
        family: boolean;
        inAppAllowed: boolean;
        emailAllowed: boolean;
        pushAllowed: boolean;
    }>`select u.id,u.created_at as "registeredAt",max(s.authenticated_at) as "activeAt",
       exists(select 1 from meal.family_memberships fm where fm.user_id=u.id and fm.left_at is null) as family,
       not exists(select 1 from meal.notification_preferences np where np.user_id=u.id and np.category='news' and np.channel='in_app' and not np.enabled) as "inAppAllowed",
       not exists(select 1 from meal.notification_preferences np where np.user_id=u.id and np.category='news' and np.channel='email' and not np.enabled) as "emailAllowed",
       exists(select 1 from meal.push_subscriptions ps where ps.user_id=u.id and ps.revoked_at is null) and not exists(select 1 from meal.notification_preferences np where np.user_id=u.id and np.category='news' and np.channel='push' and not np.enabled) as "pushAllowed"
     from meal.users u left join meal.sessions s on s.user_id=u.id
     where u.status='active' and u.archived_at is null and u.email_verified_at is not null
     group by u.id`.execute(db);
    const selected: string[] = [];
    for (const user of users.rows) {
        const plan = (await entitlements.resolve(user.id, db)).plan;
        const hasMarketingConsent =
            content.category !== 'marketing' || (await legalConsents.allowsFeatureAccess(user.id, 'marketing', db));
        const marketingAllowed = marketingDeliveryAllowed(content.category, hasMarketingConsent);
        const audience = content.audience;
        const inRange = (value: Date | null, from: string | null, to: string | null) =>
            (!from && !to) || (!!value && (!from || value >= new Date(from)) && (!to || value <= new Date(to)));
        if (
            (!audience.plans.length || audience.plans.includes(plan)) &&
            (!audience.genders.length || audience.genders.includes('unknown')) &&
            (!audience.families.length || audience.families.includes(user.family ? 'yes' : 'no')) &&
            inRange(user.registeredAt, audience.registeredFrom, audience.registeredTo) &&
            inRange(user.activeAt, audience.activeFrom, audience.activeTo) &&
            content.channels.some((channel) =>
                channel === 'in_app' ? user.inAppAllowed : channel === 'email' ? user.emailAllowed : user.pushAllowed,
            ) &&
            marketingAllowed
        )
            selected.push(user.id);
    }
    return selected;
}

export async function deliverNewsInApp(
    tx: Transaction<DatabaseSchema>,
    announcementId: string,
    announcementRevision: number,
    content: NewsContent,
    userIds: readonly string[],
) {
    let inserted = 0;
    for (const userId of userIds) {
        const result = await tx
            .insertInto('notifications')
            .values({
                id: randomUUID(),
                category: 'news',
                priority: content.category === 'marketing' ? 'marketing' : 'informational',
                payload_minimized: { type: 'news-published', newsId: announcementId, title: content.title },
                dedup_key: `news:${announcementId}:${announcementRevision}:${userId}`,
                available_at: new Date(),
                read_at: null,
                fullscreen_seen_at: null,
                user_id: userId,
                ownership_transfer_id: null,
                announcement_id: announcementId,
            })
            .onConflict((conflict) => conflict.columns(['user_id', 'dedup_key']).doNothing())
            .executeTakeFirst();
        inserted += Number(result.numInsertedOrUpdatedRows ?? 0);
    }
    return inserted;
}
