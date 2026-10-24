import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { publicRecipeImage } from '../recipes/recipes.domain.js';
import {
    brandSearchItemSchema,
    productSearchItemSchema,
    recipeSearchItemSchema,
    searchQuerySchema,
    searchResultSchema,
    storeSearchItemSchema,
    type SearchQuery,
    type SearchType,
} from './search.contracts.js';

const cursorSchema = z.strictObject({
    type: z.enum(['product', 'recipe', 'brand', 'store']),
    q: z.string().min(1).max(200),
    name: z.string(),
    id: z.uuid(),
});

type Cursor = z.infer<typeof cursorSchema>;
type Row = Record<string, unknown>;

function encodeCursor(value: Cursor): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): Cursor {
    try {
        return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    } catch {
        throw new BadRequestException('Некорректный cursor');
    }
}

function pageResult<T extends Row>(type: SearchType, rows: T[], query: SearchQuery) {
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
        type,
        page,
        nextCursor:
            rows.length > query.limit && last
                ? encodeCursor({ type, q: query.q, name: String(last.name), id: String(last.id) })
                : null,
    };
}

@Injectable()
export class SearchService {
    constructor(private readonly database: DatabaseService) {}

    private async db(): Promise<Kysely<DatabaseSchema>> {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }

    async list(userId: string, raw: unknown) {
        const query = searchQuerySchema.parse(raw);
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;
        if (cursor && (cursor.type !== query.type || cursor.q !== query.q))
            throw new BadRequestException('Cursor принадлежит другой выборке');
        const db = await this.db();
        switch (query.type) {
            case 'product':
                return this.products(db, userId, query, cursor);
            case 'recipe':
                return this.recipes(db, query, cursor);
            case 'brand':
                return this.brands(db, query, cursor);
            case 'store':
                return this.stores(db, query, cursor);
        }
    }

    private async products(db: Kysely<DatabaseSchema>, userId: string, query: SearchQuery, cursor: Cursor | null) {
        const after = cursor ? sql`and (lower(i.name),i.id)>(lower(${cursor.name}),${cursor.id}::uuid)` : sql``;
        const rows = await sql<Row>`
          select i.id,i.name,c.code as "categoryCode",u.code as "defaultUnit",
            case when i.status in('active','approved','published') then 'approved' else 'pending' end as status
          from meal.ingredients i
          join meal.categories c on c.id=i.primary_category_id
          join meal.units u on u.id=i.default_unit_id
          where (
              i.status in('active','approved','published')
              or exists(
                  select 1 from meal.catalog_proposals cp
                  join meal.brand_products bp on bp.id=cp.product_id
                  join meal.ingredient_variants iv on iv.id=bp.variant_id
                  where iv.ingredient_id=i.id and cp.author_id=${userId}::uuid
                    and cp.status in('draft','pending','submitted','needs_changes')
              )
            )
            and (
              position(lower(${query.q}) in lower(i.name))>0
              or exists(
                  select 1 from jsonb_array_elements_text(coalesce(i.aliases,'[]'::jsonb)) alias(value)
                  where position(lower(${query.q}) in lower(alias.value))>0
              )
            )
            ${after}
          order by lower(i.name),i.id
          limit ${query.limit + 1}`.execute(db);
        const result = pageResult('product', rows.rows, query);
        return searchResultSchema.parse({
            type: result.type,
            items: result.page.map((row) => productSearchItemSchema.parse({ type: 'product', ...row })),
            nextCursor: result.nextCursor,
        });
    }

    private async recipes(db: Kysely<DatabaseSchema>, query: SearchQuery, cursor: Cursor | null) {
        const after = cursor ? sql`and (lower(p.title),p.id)>(lower(${cursor.name}),${cursor.id}::uuid)` : sql``;
        const rows = await sql<Row>`
          with published as (
            select distinct on(r.id)
              r.id,rr.title,rr.description,rr.image_url,rr.category,rr.timing,pub.published_at,u.login as author_login
            from meal.recipes r
            join meal.recipe_revisions rr on rr.recipe_id=r.id
            join meal.recipe_publications pub on pub.revision_id=rr.id
            join meal.users u on u.id=r.author_id and u.status='active'
              and u.archived_at is null and u.email_verified_at is not null
            where pub.unpublished_at is null and pub.published_at<=now()
              and r.archived_at is null and r.status not in('hidden','unpublished','deleted','archived')
              and not exists(
                  select 1 from meal.sanctions s where s.user_id=u.id and s.scope='account'
                    and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())
              )
            order by r.id,pub.published_at desc,pub.id desc
          )
          select p.id,p.title,p.title as name,p.description,p.image_url as "imageUrl",p.author_login as "authorLogin",
            p.category,
            (case when jsonb_typeof(p.timing)='object' and (p.timing->>'durationMinutes')~'^\\d+$'
              then (p.timing->>'durationMinutes')::integer else null end) as "durationMinutes",
            (select avg(rating.value)::float8 from meal.recipe_ratings rating where rating.recipe_id=p.id) as rating,
            (select count(*)::integer from meal.recipe_ratings rating where rating.recipe_id=p.id) as "ratingCount"
          from published p
          where position(lower(${query.q}) in lower(p.title||' '||coalesce(p.description,'')))>0
            ${after}
          order by lower(p.title),p.id
          limit ${query.limit + 1}`.execute(db);
        const result = pageResult('recipe', rows.rows, query);
        return searchResultSchema.parse({
            type: result.type,
            items: result.page.map(({ name: ignored, ...row }) => {
                void ignored;
                return recipeSearchItemSchema.parse({
                    type: 'recipe',
                    ...row,
                    imageUrl: publicRecipeImage(row.imageUrl),
                });
            }),
            nextCursor: result.nextCursor,
        });
    }

    private async brands(db: Kysely<DatabaseSchema>, query: SearchQuery, cursor: Cursor | null) {
        const after = cursor ? sql`and (lower(b.name),b.id)>(lower(${cursor.name}),${cursor.id}::uuid)` : sql``;
        const rows = await sql<Row>`
          select b.id,b.name,
            (select count(*)::integer from meal.brand_products bp where bp.brand_id=b.id
              and bp.status in('active','approved','published')) as "productCount"
          from meal.brands b
          where position(lower(${query.q}) in lower(b.name))>0 ${after}
          order by lower(b.name),b.id
          limit ${query.limit + 1}`.execute(db);
        const result = pageResult('brand', rows.rows, query);
        return searchResultSchema.parse({
            type: result.type,
            items: result.page.map((row) => brandSearchItemSchema.parse({ type: 'brand', ...row })),
            nextCursor: result.nextCursor,
        });
    }

    private async stores(db: Kysely<DatabaseSchema>, query: SearchQuery, cursor: Cursor | null) {
        const after = cursor ? sql`and (lower(s.name),s.id)>(lower(${cursor.name}),${cursor.id}::uuid)` : sql``;
        const rows = await sql<Row>`
          select s.id,s.name from meal.stores s
          where position(lower(${query.q}) in lower(s.name))>0 ${after}
          order by lower(s.name),s.id
          limit ${query.limit + 1}`.execute(db);
        const result = pageResult('store', rows.rows, query);
        return searchResultSchema.parse({
            type: result.type,
            items: result.page.map((row) => storeSearchItemSchema.parse({ type: 'store', ...row })),
            nextCursor: result.nextCursor,
        });
    }
}
