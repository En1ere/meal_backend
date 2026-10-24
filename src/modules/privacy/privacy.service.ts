import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import { privacyStateSchema, privacyUpdateSchema } from './privacy.contracts.js';

type Connection = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
@Injectable()
export class PrivacyService {
    constructor(private readonly database: DatabaseService) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    async state(userId: string, connection?: Connection) {
        const db = connection ?? (await this.db());
        const rows = await sql<{ version: number; acceptedAt: Date | null; consentVersion: string | null }>`
            select coalesce(sum(c.version),0)::integer version,
            max(c.accepted_at) filter(where c.withdrawn_at is null and d.id=(select id from meal.legal_documents where kind='ai_data_access' and effective_at<=now() order by version desc limit 1)) as "acceptedAt",
            max(d.version::text) filter(where c.withdrawn_at is null and d.id=(select id from meal.legal_documents where kind='ai_data_access' and effective_at<=now() order by version desc limit 1)) as "consentVersion"
            from meal.user_consents c join meal.legal_documents d on d.id=c.document_id where c.user_id=${userId}::uuid and d.kind='ai_data_access'`.execute(
            db,
        );
        const row = rows.rows[0]!;
        return privacyStateSchema.parse({
            version: row.version,
            aiAccess: {
                enabled: !!row.acceptedAt,
                acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
                consentVersion: row.consentVersion,
                enableAvailable: false,
                demonstration: false,
            },
        });
    }
    async assertAiAccess(userId: string, connection?: Connection) {
        if (!(await this.state(userId, connection)).aiAccess.enabled)
            throw new HttpException(
                { code: 'AI_DATA_ACCESS_REQUIRED', message: 'Включите единый доступ AI в настройках приватности.' },
                403,
            );
    }
    async update(userId: string, raw: unknown) {
        const input = privacyUpdateSchema.parse(raw);
        if (input.enabled)
            throw new ServiceUnavailableException({
                code: 'AI_CONSENT_DOCUMENT_UNAVAILABLE',
                message: 'Включение доступа требует утверждённого юридического документа.',
            });
        return this.database.transaction(async (tx) => {
            await sql`select id from meal.users where id=${userId}::uuid for update`.execute(tx);
            const current = await this.state(userId, tx);
            // Revocation is naturally idempotent: replay never re-enables or duplicates consent.
            if (!current.aiAccess.enabled) return current;
            if (current.version !== input.expectedVersion)
                throw new HttpException('Настройки изменились. Обновите данные.', 412);
            await sql`update meal.user_consents set withdrawn_at=now(),version=version+1 where user_id=${userId}::uuid and withdrawn_at is null and document_id in(select id from meal.legal_documents where kind='ai_data_access')`.execute(
                tx,
            );
            return this.state(userId, tx);
        });
    }
}
