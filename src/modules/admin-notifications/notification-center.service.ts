import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
    UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import {
    notificationCenterSchema,
    notificationCenterUpdateSchema,
    notificationReadSchema,
    validNotificationTimeZone,
    type NotificationCategory,
    type NotificationCenterSettings,
} from './notification-center.contracts.js';

type Tx = Transaction<DatabaseSchema>;
const channels = () => ({ browser: false, mobilePush: false, email: false });
export const defaultAdminNotificationSettings = (): NotificationCenterSettings => ({
    categories: {
        security: channels(),
        payments: channels(),
        support: channels(),
        moderation: channels(),
        operations: channels(),
        campaigns: channels(),
    },
    quietHours: { start: '22:00', end: '08:00', timeZone: 'Europe/Moscow' },
    thresholds: { count: 5, windowMinutes: 10, repeatMinutes: 30 },
});

const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const safeText = (value: unknown, fallback: string, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
const category = (value: string): NotificationCategory => {
    if (/security|auth|account/.test(value)) return 'security';
    if (/payment|billing|subscription/.test(value)) return 'payments';
    if (/support/.test(value)) return 'support';
    if (/moderation|recipe|catalog/.test(value)) return 'moderation';
    if (/campaign|announcement|news/.test(value)) return 'campaigns';
    return 'operations';
};
const destination = (value: NotificationCategory) =>
    ({
        security: '/admin/access',
        payments: '/admin/payments',
        support: '/admin/support',
        moderation: '/admin/queues/recipes',
        operations: '/admin/errors',
        campaigns: '/admin/news',
    })[value];

@Injectable()
export class NotificationCenterService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    private async assertActor(tx: Tx, actor: Principal) {
        const session = await tx
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .select('sessions.id')
            .where('sessions.id', '=', actor.sessionId)
            .where('users.id', '=', actor.id)
            .where('sessions.auth_context', '=', 'admin')
            .where('sessions.revoked_at', 'is', null)
            .where('sessions.expires_at', '>', new Date())
            .where('users.status', '=', 'active')
            .where('users.archived_at', 'is', null)
            .executeTakeFirst();
        if (!session || actor.context !== 'admin') throw new UnauthorizedException();
    }

    private async snapshot(db: NonNullable<DatabaseService['db']> | Tx, actorId: string) {
        const [user, saved, rows] = await Promise.all([
            db
                .selectFrom('users')
                .select(['email_normalized', 'email_verified_at'])
                .where('id', '=', actorId)
                .executeTakeFirst(),
            db
                .selectFrom('admin_notification_settings')
                .select(['settings', 'version'])
                .where('user_id', '=', actorId)
                .executeTakeFirst(),
            db
                .selectFrom('notifications')
                .select(['id', 'category', 'payload_minimized', 'created_at', 'read_at'])
                .where('user_id', '=', actorId)
                .where('available_at', '<=', new Date())
                .orderBy('created_at', 'desc')
                .limit(100)
                .execute(),
        ]);
        if (!user) throw new NotFoundException();
        const settings = saved
            ? notificationCenterUpdateSchema.shape.settings.parse(saved.settings)
            : defaultAdminNotificationSettings();
        return notificationCenterSchema.parse({
            version: Number(saved?.version ?? 1),
            settings,
            verifiedEmail: user.email_verified_at ? user.email_normalized : null,
            deliveryConnected: false,
            items: rows.map((row) => {
                const payload = object(row.payload_minimized);
                const itemCategory = category(row.category);
                return {
                    id: row.id,
                    category: itemCategory,
                    title: safeText(payload.title, 'Событие администрирования', 200),
                    summary: safeText(payload.body ?? payload.summary, 'Откройте раздел для проверки события.', 1000),
                    createdAt: new Date(row.created_at).toISOString(),
                    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
                    occurrences:
                        typeof payload.groupedCount === 'number' && payload.groupedCount >= 1
                            ? Math.floor(payload.groupedCount)
                            : 1,
                    destination: destination(itemCategory),
                };
            }),
        });
    }

    async read(actor: Principal) {
        return this.snapshot(await this.db(), actor.id);
    }

    update(raw: unknown, actor: Principal, requestId: string) {
        const input = notificationCenterUpdateSchema.parse(raw);
        if (!validNotificationTimeZone(input.settings.quietHours.timeZone)) throw new BadRequestException();
        if (input.settings.quietHours.start === input.settings.quietHours.end) throw new BadRequestException();
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const user = await tx
                .selectFrom('users')
                .select(['email_verified_at'])
                .where('id', '=', actor.id)
                .forUpdate()
                .executeTakeFirstOrThrow();
            if (!user.email_verified_at && Object.values(input.settings.categories).some((entry) => entry.email))
                throw new BadRequestException('Email is not verified');
            const current = await tx
                .selectFrom('admin_notification_settings')
                .select(['id', 'version'])
                .where('user_id', '=', actor.id)
                .forUpdate()
                .executeTakeFirst();
            const version = Number(current?.version ?? 1);
            if (version !== input.expectedVersion) throw new ConflictException('Settings changed');
            const next = current ? version + 1 : 1;
            await tx
                .insertInto('admin_notification_settings')
                .values({ id: randomUUID(), user_id: actor.id, settings: input.settings, version: next })
                .onConflict((conflict) =>
                    conflict.column('user_id').doUpdateSet({
                        settings: input.settings,
                        updated_at: new Date(),
                        version: next,
                    }),
                )
                .execute();
            await this.audit(tx, actor, requestId, 'admin.notification-center.settings');
            return this.snapshot(tx, actor.id);
        });
    }

    markRead(raw: unknown, actor: Principal, requestId: string) {
        const input = notificationReadSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.assertActor(tx, actor);
            const row = await tx
                .selectFrom('notifications')
                .select(['id', 'read_at', 'version'])
                .where('id', '=', input.id)
                .where('user_id', '=', actor.id)
                .forUpdate()
                .executeTakeFirst();
            if (!row) throw new NotFoundException();
            if (!row.read_at)
                await tx
                    .updateTable('notifications')
                    .set({ read_at: new Date(), version: Number(row.version) + 1 })
                    .where('id', '=', row.id)
                    .execute();
            await this.audit(tx, actor, requestId, 'admin.notification-center.read', row.id);
            return this.snapshot(tx, actor.id);
        });
    }

    private async audit(tx: Tx, actor: Principal, requestId: string, action: string, targetId = actor.id) {
        await tx
            .insertInto('audit_events')
            .values({
                id: randomUUID(),
                action,
                target_type: 'admin_notification',
                target_id: targetId,
                actor_id: actor.id,
                scope_id: null,
                effective_at: new Date(),
                recorded_at: new Date(),
                request_id: requestId,
                reason: null,
                before_redacted: null,
                after_redacted: null,
            })
            .execute();
    }
}
