import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { LegalConsentService } from '../legal-consents/legal-consent.service.js';
import { newsContentSchema } from './admin-news.contracts.js';
import { deliverNewsInApp, resolveNewsAudience } from './news-delivery.js';

export type ScheduledNewsRun = {
    inspected: number;
    published: number;
    notificationsCreated: number;
    skippedInvalid: number;
};

@Injectable()
export class ScheduledNewsRunner {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
        private readonly legalConsents: LegalConsentService,
    ) {}

    /** Safe for overlapping workers: rows are locked with SKIP LOCKED and delivery has a stable dedup key. */
    async runDue(limit = 25, clock = new Date()): Promise<ScheduledNewsRun> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new RangeError('limit must be between 1 and 100');
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.transaction(async (tx) => {
            const rows = await sql<{
                id: string;
                revision: number;
                version: number;
                authorId: string;
                content: unknown;
            }>`select a.id,a.revision,a.version::integer,a.author_id as "authorId",v.content
               from meal.announcements a
               join meal.announcement_versions v on v.announcement_id=a.id and v.revision=a.revision
              where a.status='scheduled' and a.publish_at<=${clock}
              order by a.publish_at,a.id
              limit ${limit}
              for update of a skip locked`.execute(tx);
            const result: ScheduledNewsRun = {
                inspected: rows.rows.length,
                published: 0,
                notificationsCreated: 0,
                skippedInvalid: 0,
            };
            for (const row of rows.rows) {
                const parsed = newsContentSchema.safeParse(row.content);
                // External delivery is deliberately fail-closed until reviewed providers exist.
                if (!parsed.success || parsed.data.channels.some((channel) => channel !== 'in_app')) {
                    result.skippedInvalid += 1;
                    continue;
                }
                const recipients = await resolveNewsAudience(parsed.data, tx, this.entitlements, this.legalConsents);
                result.notificationsCreated += await deliverNewsInApp(
                    tx,
                    row.id,
                    row.revision,
                    parsed.data,
                    recipients,
                );
                const updated = await tx
                    .updateTable('announcements')
                    .set({ status: 'published', publish_at: clock, version: row.version + 1 })
                    .where('id', '=', row.id)
                    .where('status', '=', 'scheduled')
                    .where('version', '=', String(row.version))
                    .executeTakeFirst();
                if (Number(updated.numUpdatedRows ?? 0) !== 1) continue;
                result.published += 1;
                await tx
                    .insertInto('audit_events')
                    .values({
                        id: randomUUID(),
                        action: 'admin.news.scheduled-publish',
                        target_type: 'announcement',
                        target_id: row.id,
                        effective_at: clock,
                        recorded_at: new Date(),
                        reason: null,
                        before_redacted: { status: 'scheduled', revision: row.revision },
                        after_redacted: { status: 'published', recipients: recipients.length },
                        request_id: randomUUID(),
                        actor_id: row.authorId,
                        scope_id: null,
                    })
                    .execute();
            }
            return result;
        });
    }
}
