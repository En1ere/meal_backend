import { sql, type RawBuilder } from 'kysely';
import type { AdminSection } from './admin-read.contracts.js';

export interface RelatedSource {
    table: string;
    label: string;
    title: string;
    status: string | null;
    fields: readonly (readonly [string, string])[];
    predicate: (id: string) => RawBuilder<boolean>;
}
const direct = (column: string) => (id: string) => sql<boolean>`${sql.ref(column)} = ${id}::uuid`;
const attempt = (id: string) =>
    sql<boolean>`attempt_id in (select id from meal.payment_attempts where order_id = ${id}::uuid)`;
const source = (
    table: string,
    label: string,
    title: string,
    status: string | null,
    fields: RelatedSource['fields'],
    predicate: RelatedSource['predicate'],
): RelatedSource => ({ table, label, title, status, fields, predicate });

// Constant SQL identifiers/relations only. No provider payloads, contact addresses, bearer tokens,
// arbitrary snapshots, recipient lists, error JSON or unvalidated HTML cross this projection.
export const adminRelatedSources: Partial<Record<AdminSection, Record<string, RelatedSource>>> = {
    users: {
        roles: source(
            'staff_role_assignments',
            'Служебные роли',
            'role',
            null,
            [
                ['assigned_at', 'Выдано'],
                ['revoked_at', 'Отозвано'],
                ['assigned_by', 'Выдал'],
            ],
            direct('user_id'),
        ),
        sanctions: source(
            'sanctions',
            'Санкции',
            'scope',
            null,
            [
                ['reason', 'Причина'],
                ['starts_at', 'Начало'],
                ['ends_at', 'Конец'],
                ['revoked_at', 'Снято'],
            ],
            direct('user_id'),
        ),
        support: source(
            'support_tickets',
            'Обращения пользователя',
            'subject',
            'status',
            [
                ['category', 'Категория'],
                ['public_number', 'Номер'],
                ['closed_at', 'Закрыто'],
            ],
            direct('requester_id'),
        ),
        audit: source(
            'audit_events',
            'События пользователя',
            'action',
            null,
            [
                ['target_type', 'Тип объекта'],
                ['target_id', 'Объект'],
                ['effective_at', 'Действует с'],
                ['recorded_at', 'Записано'],
            ],
            direct('actor_id'),
        ),
    },
    sanctions: {
        appeals: source(
            'appeals',
            'Апелляции',
            'status',
            'status',
            [
                ['body', 'Текст обращения'],
                ['submitted_at', 'Подано'],
                ['resolved_at', 'Рассмотрено'],
            ],
            direct('sanction_id'),
        ),
    },
    subscriptions: {
        periods: source(
            'subscription_periods',
            'Периоды подписки',
            'grant_kind',
            null,
            [
                ['starts_at', 'Начало'],
                ['ends_at', 'Конец'],
                ['order_id', 'Заказ'],
            ],
            direct('subscription_id'),
        ),
        changes: source(
            'subscription_changes',
            'Изменения подписки',
            'kind',
            'status',
            [
                ['scheduled_at', 'Запланировано'],
                ['applied_at', 'Применено'],
                ['reason', 'Причина'],
                ['actor_id', 'Инициатор'],
            ],
            direct('subscription_id'),
        ),
        coverage: source(
            'family_coverages',
            'Семейное покрытие',
            'reason',
            null,
            [
                ['family_id', 'Семья'],
                ['starts_at', 'Начало'],
                ['ends_at', 'Конец'],
                ['selected_at', 'Выбрано'],
            ],
            direct('subscription_id'),
        ),
        grace: source(
            'grace_incidents',
            'Страховые периоды',
            'reason',
            null,
            [
                ['starts_at', 'Начало'],
                ['ends_at', 'Конец'],
                ['extended_at', 'Продлено'],
                ['extended_by', 'Сотрудник'],
            ],
            direct('subscription_id'),
        ),
        'ai-buckets': source(
            'ai_buckets',
            'AI-квоты подписки',
            'kind',
            null,
            [
                ['granted', 'Выдано'],
                ['balance_projection', 'Остаток'],
                ['reserved_projection', 'Зарезервировано'],
                ['expires_at', 'Истекает'],
            ],
            (id) =>
                sql<boolean>`quota_period_id in (select id from meal.ai_quota_periods where subscription_id = ${id}::uuid or family_coverage_id in (select id from meal.family_coverages where subscription_id = ${id}::uuid))`,
        ),
        'ai-ledger': source(
            'ai_ledger',
            'Движения AI-квоты',
            'kind',
            null,
            [
                ['delta', 'Изменение'],
                ['reserved_delta', 'Изменение резерва'],
                ['recorded_at', 'Записано'],
                ['bucket_id', 'Квота'],
            ],
            (id) =>
                sql<boolean>`bucket_id in (select id from meal.ai_buckets where quota_period_id in (select id from meal.ai_quota_periods where subscription_id = ${id}::uuid or family_coverage_id in (select id from meal.family_coverages where subscription_id = ${id}::uuid)))`,
        ),
    },
    families: {
        memberships: source(
            'family_memberships',
            'Участники',
            'user_id',
            null,
            [
                ['joined_at', 'Вступил'],
                ['left_at', 'Вышел'],
                ['stable_order', 'Порядок'],
            ],
            direct('family_id'),
        ),
        coverage: source(
            'family_coverages',
            'Покрытие Plus',
            'reason',
            null,
            [
                ['subscription_id', 'Подписка'],
                ['starts_at', 'Начало'],
                ['ends_at', 'Конец'],
                ['selected_at', 'Выбрано'],
            ],
            direct('family_id'),
        ),
    },
    payments: {
        attempts: source(
            'payment_attempts',
            'Попытки оплаты',
            'provider',
            'status',
            [['amount_minor', 'Сумма в минимальных единицах']],
            direct('order_id'),
        ),
        reconciliations: source(
            'payment_reconciliations',
            'Сверки',
            'id',
            'status',
            [
                ['attempt_id', 'Попытка'],
                ['requested_at', 'Запрошено'],
                ['requested_by', 'Сотрудник'],
                ['reason', 'Причина'],
            ],
            attempt,
        ),
        refunds: source(
            'payment_refunds',
            'Возвраты',
            'id',
            'status',
            [
                ['amount_minor', 'Сумма в минимальных единицах'],
                ['attempt_id', 'Попытка'],
                ['requested_by', 'Сотрудник'],
                ['reason', 'Причина'],
            ],
            attempt,
        ),
        documents: source(
            'billing_documents',
            'Платёжные документы',
            'kind',
            null,
            [
                ['issued_at', 'Выдан'],
                ['amount_minor', 'Сумма в минимальных единицах'],
            ],
            direct('order_id'),
        ),
    },
    queues: {
        'recipe-revisions': source(
            'recipe_revisions',
            'Редакции рецепта',
            'title',
            null,
            [
                ['revision', 'Редакция'],
                ['portions', 'Порции'],
                ['method', 'Способ'],
                ['change_kind', 'Изменение'],
                ['created_by', 'Автор'],
            ],
            (id) =>
                sql<boolean>`recipe_id in (select recipe_id from meal.recipe_revisions where id in (select recipe_revision_id from meal.moderation_cases where id = ${id}::uuid))`,
        ),
        'catalog-revisions': source(
            'catalog_proposal_revisions',
            'Редакции предложения каталога',
            'revision',
            null,
            [
                ['proposal_id', 'Предложение'],
                ['author_id', 'Автор'],
            ],
            (id) =>
                sql<boolean>`proposal_id in (select proposal_id from meal.catalog_proposal_revisions where id in (select catalog_proposal_revision_id from meal.moderation_cases where id = ${id}::uuid))`,
        ),
        decisions: source(
            'moderation_decisions',
            'Решения',
            'action',
            null,
            [
                ['reason', 'Причина'],
                ['decided_at', 'Решение принято'],
                ['actor_id', 'Сотрудник'],
            ],
            direct('case_id'),
        ),
        claims: source(
            'moderation_claims',
            'Назначения',
            'outcome',
            null,
            [
                ['staff_id', 'Сотрудник'],
                ['claimed_at', 'Взято'],
                ['lease_until', 'Захват до'],
                ['released_at', 'Освобождено'],
            ],
            direct('case_id'),
        ),
    },
    catalog: {
        variants: source(
            'ingredient_variants',
            'Вариант ингредиента',
            'name',
            'status',
            [['ingredient_id', 'Ингредиент']],
            (id) => sql<boolean>`id in (select variant_id from meal.brand_products where id = ${id}::uuid)`,
        ),
        barcodes: source(
            'product_barcodes',
            'Штрихкоды',
            'code',
            null,
            [
                ['format', 'Формат'],
                ['verified_at', 'Проверено'],
            ],
            direct('product_id'),
        ),
        compositions: source(
            'composition_versions',
            'Состав и пищевая ценность',
            'revision',
            null,
            [
                ['composition_text', 'Состав'],
                ['kcal', 'Ккал'],
                ['protein', 'Белки'],
                ['fat', 'Жиры'],
                ['carbs', 'Углеводы'],
                ['basis_quantity', 'На количество'],
                ['basis_unit_id', 'Единица'],
                ['source', 'Источник'],
                ['confidence', 'Достоверность'],
            ],
            direct('product_id'),
        ),
        merges: source(
            'catalog_merges',
            'История объединений',
            'kind',
            'status',
            [
                ['reason', 'Причина'],
                ['applied_at', 'Применено'],
                ['source_product_id', 'Исходный товар'],
                ['target_product_id', 'Итоговый товар'],
                ['actor_id', 'Сотрудник'],
            ],
            (id) => sql<boolean>`source_product_id = ${id}::uuid or target_product_id = ${id}::uuid`,
        ),
    },
    news: {
        campaigns: source(
            'mail_campaigns',
            'Почтовые кампании',
            'kind',
            'status',
            [
                ['scheduled_at', 'Запланировано'],
                ['created_by', 'Автор'],
            ],
            direct('announcement_id'),
        ),
        deliveries: source(
            'notification_deliveries',
            'Статусы доставки',
            'channel',
            'status',
            [
                ['scheduled_at', 'Запланировано'],
                ['sent_at', 'Отправлено'],
                ['attempt_no', 'Попытка'],
            ],
            (id) =>
                sql<boolean>`campaign_id in (select id from meal.mail_campaigns where announcement_id = ${id}::uuid) or notification_id in (select id from meal.notifications where announcement_id = ${id}::uuid)`,
        ),
    },
    access: {
        roles: source(
            'staff_role_assignments',
            'История ролей',
            'role',
            null,
            [
                ['assigned_at', 'Выдано'],
                ['revoked_at', 'Отозвано'],
                ['assigned_by', 'Выдал'],
            ],
            direct('user_id'),
        ),
        grants: source(
            'staff_grants',
            'Служебные разрешения',
            'permission',
            null,
            [
                ['scope', 'Область'],
                ['valid_until', 'Действует до'],
                ['revoked_at', 'Отозвано'],
                ['granted_by', 'Выдал'],
            ],
            direct('user_id'),
        ),
        sessions: source(
            'sessions',
            'Служебные сессии',
            'auth_context',
            null,
            [
                ['authenticated_at', 'Вход'],
                ['mfa_verified_at', 'MFA'],
                ['expires_at', 'Истекает'],
                ['revoked_at', 'Отозвана'],
            ],
            (id) => sql<boolean>`user_id = ${id}::uuid and kind = 'staff'`,
        ),
    },
    'legal-requests': {
        steps: source(
            'legal_request_steps',
            'Этапы правового запроса',
            'kind',
            'status',
            [
                ['completed_at', 'Завершено'],
                ['approved_by', 'Согласовал'],
            ],
            direct('request_id'),
        ),
    },
    rollback: {
        items: source(
            'compensation_items',
            'Элементы компенсации',
            'id',
            'status',
            [
                ['source_event_id', 'Исходное событие'],
                ['result_event_id', 'Итоговое событие'],
            ],
            direct('request_id'),
        ),
    },
    operations: {
        attempts: source(
            'job_attempts',
            'Попытки выполнения',
            'attempt_no',
            null,
            [
                ['started_at', 'Начало'],
                ['finished_at', 'Завершение'],
            ],
            direct('job_id'),
        ),
    },
    support: {
        events: source(
            'support_events',
            'История обращения и назначения',
            'kind',
            null,
            [
                ['recorded_at', 'Записано'],
                ['actor_id', 'Сотрудник'],
                ['reason', 'Причина'],
            ],
            direct('ticket_id'),
        ),
    },
};

export function relatedCollections(section: AdminSection) {
    return Object.entries(adminRelatedSources[section] ?? {}).map(([key, definition]) => ({
        key,
        label: definition.label,
    }));
}
