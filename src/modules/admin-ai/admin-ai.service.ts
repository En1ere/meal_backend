import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AdminReadBoundary } from '../admin-auth/public.js';
import type { Principal } from '../auth/public.js';
import {
    AI_CONTEXT_POLICY_VERSION,
    AI_TASK_RULE_VERSION,
    AiProvider,
    aiTaskAvailable,
    aiTaskContextPolicies,
    aiTasks,
} from '../ai/public.js';
import { adminAiControlPlaneSchema } from './admin-ai.contracts.js';

const plans = ['free', 'plus', 'pro'] as const;
const count = (value: string | number) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) throw new Error('Invalid aggregate');
    return parsed;
};

type UsageRow = {
    window: string;
    tasks: string;
    actions: string;
    completed: string;
    refunded: string;
    failed: string;
};

@Injectable()
export class AdminAiService {
    constructor(
        private readonly boundary: AdminReadBoundary,
        private readonly provider: AiProvider,
    ) {}

    read(actor: Principal, requestId: string, now = new Date()) {
        return this.boundary.run(
            actor,
            requestId,
            { action: 'admin.ai.read', targetType: 'ai-control-plane' },
            async (tx) => {
                const [rules, usage, statuses, lifecycle, financial, operationAges] = await Promise.all([
                    sql<{
                        kind: string;
                        version: string;
                        effectiveAt: Date;
                    }>`select kind,case when kind='cost' then config->>'taskRuleVersion' else config->>'contextVersion' end as version,effective_at as "effectiveAt" from meal.ai_rule_versions where ((kind='cost' and config->>'taskRuleVersion'=${AI_TASK_RULE_VERSION}) or (kind='context' and config->>'contextVersion'=${AI_CONTEXT_POLICY_VERSION})) and effective_at<=${now} order by kind,version desc`.execute(
                        tx,
                    ),
                    sql<UsageRow>`with windows(window,since) as (values ('last24Hours',${new Date(now.getTime() - 86_400_000)}::timestamptz),('last30Days',${new Date(now.getTime() - 30 * 86_400_000)}::timestamptz)) select w.window,count(t.id)::text tasks,coalesce(sum(t.accepted_cost),0)::text actions,count(t.id) filter(where t.status='completed')::text completed,count(t.id) filter(where t.status='refunded')::text refunded,count(t.id) filter(where t.status='failed')::text failed from windows w left join meal.ai_tasks t on t.created_at>=w.since group by w.window`.execute(
                        tx,
                    ),
                    sql<{
                        status: string;
                        count: string;
                    }>`select status,count(*)::text count from meal.ai_tasks group by status order by status`.execute(
                        tx,
                    ),
                    sql<{
                        state: string;
                        count: string;
                    }>`select lifecycle_state state,count(*)::text count from meal.ai_operations group by lifecycle_state order by lifecycle_state`.execute(
                        tx,
                    ),
                    sql<{
                        state: string;
                        count: string;
                    }>`select financial_state state,count(*)::text count from meal.ai_operations group by financial_state order by financial_state`.execute(
                        tx,
                    ),
                    sql<{
                        oldestQueuedAt: Date | null;
                        oldestRunningAt: Date | null;
                        unknownCount: string;
                        reconciliationHoldCount: string;
                    }>`select min(queued_at) filter(where lifecycle_state='queued') "oldestQueuedAt",min(updated_at) filter(where lifecycle_state='running') "oldestRunningAt",count(*) filter(where lifecycle_state='unknown')::text "unknownCount",count(*) filter(where financial_state='reconciliation_hold')::text "reconciliationHoldCount" from meal.ai_operations`.execute(
                        tx,
                    ),
                ]);
                const rule = (kind: string) => rules.rows.find((row) => row.kind === kind);
                const projectUsage = (window: string) => {
                    const row = usage.rows.find((value) => value.window === window);
                    return {
                        tasks: count(row?.tasks ?? 0),
                        actions: count(row?.actions ?? 0),
                        completed: count(row?.completed ?? 0),
                        refunded: count(row?.refunded ?? 0),
                        failed: count(row?.failed ?? 0),
                    };
                };
                const taskRule = rule('cost');
                const contextRule = rule('context');
                const provider = this.provider.status();
                return adminAiControlPlaneSchema.parse({
                    schemaVersion: 2,
                    generatedAt: now.toISOString(),
                    executionAvailable: provider.configured && Boolean(taskRule) && Boolean(contextRule),
                    provider,
                    policies: {
                        task: {
                            version: AI_TASK_RULE_VERSION,
                            effectiveAt: taskRule?.effectiveAt.toISOString() ?? null,
                        },
                        context: {
                            version: AI_CONTEXT_POLICY_VERSION,
                            effectiveAt: contextRule?.effectiveAt.toISOString() ?? null,
                        },
                    },
                    usage: { last24Hours: projectUsage('last24Hours'), last30Days: projectUsage('last30Days') },
                    statuses: statuses.rows,
                    operations: {
                        lifecycle: lifecycle.rows.map((row) => ({ state: row.state, count: count(row.count) })),
                        financial: financial.rows.map((row) => ({ state: row.state, count: count(row.count) })),
                        oldestQueuedAt: operationAges.rows[0]?.oldestQueuedAt?.toISOString() ?? null,
                        oldestRunningAt: operationAges.rows[0]?.oldestRunningAt?.toISOString() ?? null,
                        unknownCount: count(operationAges.rows[0]?.unknownCount ?? 0),
                        reconciliationHoldCount: count(operationAges.rows[0]?.reconciliationHoldCount ?? 0),
                    },
                    tasks: aiTasks.map((task) => ({
                        code: task.code,
                        label: task.label,
                        taskClass: task.taskClass,
                        cost: task.cost,
                        availableOn: plans.filter((plan) => aiTaskAvailable(task, plan)),
                        requiredContext: [...aiTaskContextPolicies[task.code].required],
                        optionalContext: [...aiTaskContextPolicies[task.code].optional],
                    })),
                });
            },
        );
    }
}
