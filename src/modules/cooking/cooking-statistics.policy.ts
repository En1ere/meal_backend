import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';

const rulesSchema = z.strictObject({ minimumSample: z.number().int().min(3).max(1000) });
export const DEFAULT_COOKING_STATISTICS_RULE = { version: 1, minimumSample: 3, source: 'builtin' as const };

@Injectable()
export class CookingStatisticsPolicy {
    async resolve(tx: Transaction<DatabaseSchema>, clock = new Date()) {
        const result = await sql<{ version: number; rules: unknown }>`
            select version::integer,rules from meal.feature_rule_versions
             where key='cooking_statistics_publication' and enabled and effective_at<=${clock}
             order by version desc limit 1`.execute(tx);
        const row = result.rows[0];
        if (!row) return DEFAULT_COOKING_STATISTICS_RULE;
        const parsed = rulesSchema.safeParse(row.rules);
        if (!parsed.success) throw new ServiceUnavailableException('Cooking statistics policy is invalid');
        return { version: row.version, minimumSample: parsed.data.minimumSample, source: 'database' as const };
    }
}
