import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { recipeSummarySchema } from '../recipes/recipes.contracts.js';
import { publicRecipeImage } from '../recipes/recipes.domain.js';
import {
    communityCommentsQuerySchema,
    communityCommentsSchema,
    communityFeedSchema,
    communityQuerySchema,
} from './community.contracts.js';

const feedCursorSchema = z.strictObject({
    publishedAt: z.iso.datetime(),
    id: z.uuid(),
    q: z.string(),
    category: z.string().nullable(),
    author: z.string().nullable(),
    sort: z.enum(['newest', 'oldest']),
});
const commentCursorSchema = z.strictObject({ recipeId: z.uuid(), createdAt: z.iso.datetime(), id: z.uuid() });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode<T>(cursor: string, schema: z.ZodType<T>): T {
    try {
        return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
        throw new BadRequestException('Некорректный cursor');
    }
}
const date = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

@Injectable()
export class CommunityService {
    constructor(private readonly database: DatabaseService) {}

    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async feed(raw: unknown) {
        const query = communityQuerySchema.parse(raw);
        const cursor = query.cursor ? decode(query.cursor, feedCursorSchema) : null;
        if (
            cursor &&
            (cursor.q !== query.q ||
                cursor.category !== (query.category ?? null) ||
                cursor.author !== (query.author ?? null) ||
                cursor.sort !== query.sort)
        )
            throw new BadRequestException('Cursor принадлежит другой выборке');
        const db = await this.db();
        const cursorFilter = cursor
            ? query.sort === 'newest'
                ? sql`and (date_trunc('milliseconds',p.published_at),p.id)<(${cursor.publishedAt}::timestamptz,${cursor.id}::uuid)`
                : sql`and (date_trunc('milliseconds',p.published_at),p.id)>(${cursor.publishedAt}::timestamptz,${cursor.id}::uuid)`
            : sql``;
        const order =
            query.sort === 'newest'
                ? sql`date_trunc('milliseconds',p.published_at) desc,p.id desc`
                : sql`date_trunc('milliseconds',p.published_at),p.id`;
        const rows = await sql<Record<string, unknown>>`
          with published as (
            select distinct on(r.id) r.id,rr.id revision_id,rr.title,rr.description,rr.category,rr.image_url,rr.tags,rr.portions,rr.timing,pub.published_at,u.login author_login
            from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications pub on pub.revision_id=rr.id
            join meal.users u on u.id=r.author_id and u.status='active' and u.archived_at is null and u.email_verified_at is not null
            where pub.unpublished_at is null and pub.published_at<=now() and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived')
              and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))
            order by r.id,pub.published_at desc,pub.id desc
          )
          select p.id,p.revision_id as "revisionId",p.title,p.description,p.category,p.image_url as "imageUrl",p.tags,p.portions as "baseServings",p.published_at as "publishedAt",p.timing,p.author_login as "authorLogin",
            (select avg(x.value)::float8 from meal.recipe_ratings x where x.recipe_id=p.id) rating,
            (select count(*)::integer from meal.recipe_ratings x where x.recipe_id=p.id) "ratingCount"
          from published p where position(lower(${query.q}) in lower(p.title||' '||coalesce(p.description,'')))>0
            and (${query.category ?? null}::text is null or p.category=${query.category ?? null})
            and (${query.author ?? null}::text is null or lower(p.author_login)=lower(${query.author ?? null}))
            ${cursorFilter} order by ${order} limit ${query.limit + 1}`.execute(db);
        const page = rows.rows.slice(0, query.limit);
        const items = page.map((row) => {
            const timing = z
                .object({ durationMinutes: z.number().int().nonnegative().nullable().optional() })
                .safeParse(row.timing);
            return recipeSummarySchema.parse({
                ...row,
                publishedAt: date(row.publishedAt),
                imageUrl: publicRecipeImage(row.imageUrl),
                tags: Array.isArray(row.tags) ? row.tags : [],
                durationMinutes: timing.success ? (timing.data.durationMinutes ?? null) : null,
                availability: null,
            });
        });
        const last = page.at(-1);
        return communityFeedSchema.parse({
            items,
            nextCursor:
                rows.rows.length > query.limit && last
                    ? encode({
                          publishedAt: date(last.publishedAt),
                          id: String(last.id),
                          q: query.q,
                          category: query.category ?? null,
                          author: query.author ?? null,
                          sort: query.sort,
                      } satisfies z.infer<typeof feedCursorSchema>)
                    : null,
        });
    }

    async comments(recipeId: string, raw: unknown) {
        const query = communityCommentsQuerySchema.parse(raw);
        const cursor = query.cursor ? decode(query.cursor, commentCursorSchema) : null;
        if (cursor && cursor.recipeId !== recipeId) throw new BadRequestException('Cursor принадлежит другому рецепту');
        const db = await this.db();
        const published = await sql`
          select r.id from meal.recipes r join meal.recipe_revisions rr on rr.recipe_id=r.id join meal.recipe_publications p on p.revision_id=rr.id
          join meal.users u on u.id=r.author_id and u.status='active' and u.archived_at is null and u.email_verified_at is not null
          where r.id=${recipeId}::uuid and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived') and p.unpublished_at is null and p.published_at<=now()
            and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) limit 1`.execute(
            db,
        );
        if (!published.rows.length) throw new HttpException('Рецепт не опубликован', 404);
        const cursorFilter = cursor
            ? sql`and (date_trunc('milliseconds',c.created_at),c.id)>(${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`
            : sql``;
        const rows = await sql<Record<string, unknown>>`
          select c.id,c.body,u.login as "authorLogin",c.created_at as "createdAt",c.edited_at is not null as edited,c.reply_to_id as "replyToId"
          from meal.recipe_comments c join meal.users u on u.id=c.author_id and u.status='active' and u.archived_at is null and u.email_verified_at is not null
          where c.recipe_id=${recipeId}::uuid and c.removed_at is null ${cursorFilter}
            and not exists(select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))
          order by date_trunc('milliseconds',c.created_at),c.id limit ${query.limit + 1}`.execute(db);
        const page = rows.rows.slice(0, query.limit);
        const last = page.at(-1);
        return communityCommentsSchema.parse({
            items: page.map((row) => ({ ...row, createdAt: date(row.createdAt) })),
            nextCursor:
                rows.rows.length > query.limit && last
                    ? encode({ recipeId, createdAt: date(last.createdAt), id: String(last.id) })
                    : null,
        });
    }
}
