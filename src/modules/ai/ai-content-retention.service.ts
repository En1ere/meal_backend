import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

const maximumBatchSize = 100;

@Injectable()
export class AiContentRetentionService {
    constructor(private readonly database: DatabaseService) {}

    async purgeExpired(batchSize = maximumBatchSize, clock = new Date()) {
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize)
            throw new RangeError(`batchSize must be between 1 and ${maximumBatchSize}`);
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();

        return this.database.transaction(async (tx) => {
            const candidates = await sql<{ id: string }>`
                select task.id
                  from meal.ai_tasks task
                  join meal.ai_conversations conversation on conversation.id=task.conversation_id
                 where task.content_purged_at is null
                   and task.created_at<=${clock}-interval '30 days'
                   and not exists(
                       select 1 from meal.ai_operations operation
                        where operation.task_id=task.id and operation.expires_at>${clock}
                   )
                   and not exists(
                       select 1 from meal.legal_requests hold
                        where hold.user_id=conversation.user_id
                          and hold.kind='legal_hold' and hold.status in('active','approved')
                   )
                 order by task.created_at,task.id
                 limit ${batchSize}
                 for update of task skip locked
            `.execute(tx);
            const taskIds = candidates.rows.map((row) => row.id);
            if (!taskIds.length) return { attempted: 0, purgedTasks: 0, purgedMessages: 0, purgedResults: 0 };

            const messages = await sql<{ id: string }>`
                update meal.ai_messages message
                   set body='',content_purged_at=${clock},version=message.version+1
                  from meal.ai_intervals interval
                 where message.interval_id=interval.id
                   and interval.task_id=any(${taskIds}::uuid[])
                   and message.content_purged_at is null
                returning message.id
            `.execute(tx);
            const operations = await sql<{ id: string }>`
                update meal.ai_operations operation
                   set result_snapshot=null,content_purged_at=${clock},version=operation.version+1
                 where operation.task_id=any(${taskIds}::uuid[])
                   and operation.content_purged_at is null
                returning operation.id
            `.execute(tx);
            const tasks = await sql<{ id: string }>`
                update meal.ai_tasks task
                   set goal='',
                       preview=jsonb_build_object(
                           'taskType',task.preview->>'taskType',
                           'contentExpired',true
                       ),
                       content_purged_at=${clock},version=task.version+1
                 where task.id=any(${taskIds}::uuid[]) and task.content_purged_at is null
                returning task.id
            `.execute(tx);
            return {
                attempted: taskIds.length,
                purgedTasks: tasks.rows.length,
                purgedMessages: messages.rows.length,
                purgedResults: operations.rows.length,
            };
        });
    }
}
