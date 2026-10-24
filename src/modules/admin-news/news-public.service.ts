import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import {
    newsContentSchema,
    newsReadResultSchema,
    publicNewsDetailSchema,
    publicNewsListSchema,
    publicNewsQuerySchema,
    type NewsContent,
} from './admin-news.contracts.js';

const cursorSchema = z.strictObject({ publishedAt: z.iso.datetime(), id: z.uuid() });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string) {
    try {
        return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    } catch {
        throw new BadRequestException('Некорректный cursor');
    }
}
const iso = (value: Date | string) => new Date(value).toISOString();
const unrestricted = (content: NewsContent) => {
    const a = content.audience;
    return (
        !a.plans.length &&
        !a.genders.length &&
        !a.families.length &&
        !a.registeredFrom &&
        !a.registeredTo &&
        !a.activeFrom &&
        !a.activeTo
    );
};

@Injectable()
export class NewsPublicService {
    constructor(
        private readonly database: DatabaseService,
        private readonly entitlements: EntitlementsService,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private async allowed(content: NewsContent, userId?: string) {
        if (!content.channels.includes('in_app')) return false;
        if (unrestricted(content)) return true;
        if (!userId) return false;
        const db = await this.db();
        const user = await sql<{ registeredAt: Date; activeAt: Date | null; family: boolean }>`
          select u.created_at as "registeredAt",max(s.authenticated_at) as "activeAt",
            exists(select 1 from meal.family_memberships fm where fm.user_id=u.id and fm.left_at is null) family
          from meal.users u left join meal.sessions s on s.user_id=u.id where u.id=${userId}::uuid group by u.id`.execute(
            db,
        );
        const facts = user.rows[0];
        if (!facts) return false;
        const a = content.audience;
        const plan = (await this.entitlements.resolve(userId, db)).plan;
        const range = (value: Date | null, from: string | null, to: string | null) =>
            (!from && !to) || (!!value && (!from || value >= new Date(from)) && (!to || value <= new Date(to)));
        return (
            (!a.plans.length || a.plans.includes(plan)) &&
            (!a.genders.length || a.genders.includes('unknown')) &&
            (!a.families.length || a.families.includes(facts.family ? 'yes' : 'no')) &&
            range(facts.registeredAt, a.registeredFrom, a.registeredTo) &&
            range(facts.activeAt, a.activeFrom, a.activeTo)
        );
    }
    private card(id: string, publishedAt: Date | string, content: NewsContent) {
        const image = content.pages.flatMap((page) => page.blocks).find((block) => block.kind === 'image');
        return {
            id,
            type: content.type,
            title: content.title,
            publishedAt: iso(publishedAt),
            coverImage: image?.kind === 'image' ? { url: image.url, alt: image.alt } : null,
            pageCount: content.pages.length,
        };
    }
    async list(raw: unknown, userId?: string) {
        const query = publicNewsQuerySchema.parse(raw);
        const cursor = query.cursor ? decode(query.cursor) : null;
        const db = await this.db();
        const visible: { id: string; publishedAt: Date; content: NewsContent }[] = [];
        let scan = cursor;
        let exhausted = false;
        while (visible.length <= query.limit && !exhausted) {
            const rows = await sql<{ id: string; publishedAt: Date; content: unknown }>`
              select a.id,a.publish_at as "publishedAt",v.content from meal.announcements a
              join meal.announcement_versions v on v.announcement_id=a.id and v.revision=a.revision
              where a.status='published' and a.publish_at is not null and a.publish_at<=now()
                ${scan ? sql`and (a.publish_at,a.id)<(${scan.publishedAt}::timestamptz,${scan.id}::uuid)` : sql``}
              order by a.publish_at desc,a.id desc limit 100`.execute(db);
            exhausted = rows.rows.length < 100;
            for (const row of rows.rows) {
                scan = { publishedAt: iso(row.publishedAt), id: row.id };
                const content = newsContentSchema.safeParse(row.content);
                if (content.success && (await this.allowed(content.data, userId)))
                    visible.push({ ...row, content: content.data });
                if (visible.length > query.limit) break;
            }
        }
        const page = visible.slice(0, query.limit);
        const last = page.at(-1);
        return publicNewsListSchema.parse({
            items: page.map((row) => this.card(row.id, row.publishedAt, row.content)),
            nextCursor:
                visible.length > query.limit && last
                    ? encode({ publishedAt: iso(last.publishedAt), id: last.id })
                    : null,
        });
    }
    private async publication(id: string, userId?: string) {
        const db = await this.db();
        const row = (
            await sql<{ versionId: string; publishedAt: Date; content: unknown }>`
              select v.id as "versionId",a.publish_at as "publishedAt",v.content from meal.announcements a
              join meal.announcement_versions v on v.announcement_id=a.id and v.revision=a.revision
              where a.id=${id}::uuid and a.status='published' and a.publish_at is not null and a.publish_at<=now()`.execute(
                db,
            )
        ).rows[0];
        if (!row) throw new NotFoundException();
        const content = newsContentSchema.safeParse(row.content);
        if (!content.success || !(await this.allowed(content.data, userId))) throw new NotFoundException();
        return { ...row, content: content.data };
    }
    async detail(id: string, userId?: string) {
        const row = await this.publication(id, userId);
        const read = userId
            ? (
                  await sql<{
                      readAt: Date;
                  }>`select read_at as "readAt" from meal.announcement_reads where user_id=${userId}::uuid and announcement_version_id=${row.versionId}::uuid`.execute(
                      await this.db(),
                  )
              ).rows[0]
            : null;
        return publicNewsDetailSchema.parse({
            ...this.card(id, row.publishedAt, row.content),
            pages: row.content.pages,
            readAt: read ? iso(read.readAt) : null,
        });
    }
    async read(userId: string, id: string, idempotencyKey: string) {
        const publication = await this.publication(id, userId);
        return this.database.transaction(async (tx) => {
            const priorKey = await tx
                .selectFrom('announcement_reads')
                .select(['announcement_id', 'announcement_version_id', 'read_at'])
                .where('user_id', '=', userId)
                .where('idempotency_key', '=', idempotencyKey)
                .executeTakeFirst();
            if (
                priorKey &&
                (priorKey.announcement_id !== id || priorKey.announcement_version_id !== publication.versionId)
            )
                throw new ConflictException('Ключ уже использован для другой публикации');
            const prior =
                priorKey ??
                (await tx
                    .selectFrom('announcement_reads')
                    .select(['read_at'])
                    .where('user_id', '=', userId)
                    .where('announcement_version_id', '=', publication.versionId)
                    .executeTakeFirst());
            if (prior) return newsReadResultSchema.parse({ id, readAt: iso(prior.read_at) });
            const readAt = new Date();
            await tx
                .insertInto('announcement_reads')
                .values({
                    id: randomUUID(),
                    announcement_id: id,
                    announcement_version_id: publication.versionId,
                    user_id: userId,
                    idempotency_key: idempotencyKey,
                    read_at: readAt,
                })
                .execute();
            await tx
                .updateTable('notifications')
                .set({ read_at: readAt, version: sql`version+1` })
                .where('user_id', '=', userId)
                .where('announcement_id', '=', id)
                .where('read_at', 'is', null)
                .execute();
            return newsReadResultSchema.parse({ id, readAt: readAt.toISOString() });
        });
    }
}
