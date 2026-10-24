import type { AdminSection } from './admin-read.contracts.js';

interface Source {
    table: string;
    title: string;
    status: string | null;
    fields: readonly (readonly [string, string])[];
    related?: readonly (readonly [string, string, AdminSection])[];
    requiresQuery?: boolean;
    note?: string;
}
// All identifiers below are application constants, never client supplied table/column names.
export const adminSources: Record<Exclude<AdminSection, 'overview'>, Source> = {
    queues: {
        table: 'moderation_cases',
        title: 'kind',
        status: 'status',
        fields: [
            ['kind', 'Тип проверки'],
            ['submitted_at', 'Поступление'],
            ['queue_priority', 'Приоритет'],
        ],
        note: 'Показана очередь модерации контента. Платежи, обращения и правовые запросы доступны в собственных разделах.',
    },
    users: {
        table: 'users',
        title: 'display_name',
        status: 'status',
        fields: [
            ['login', 'Логин'],
            ['email_verified_at', 'Почта подтверждена'],
        ],
        related: [['id', 'Служебный доступ', 'access']],
        requiresQuery: true,
    },
    sanctions: {
        table: 'sanctions',
        title: 'scope',
        status: null,
        fields: [
            ['scope', 'Область'],
            ['starts_at', 'Начало'],
            ['ends_at', 'Окончание'],
            ['revoked_at', 'Снятие'],
            ['reason', 'Причина'],
        ],
        related: [['user_id', 'Пользователь', 'users']],
    },
    subscriptions: {
        table: 'subscriptions',
        title: 'id',
        status: 'status',
        fields: [
            ['billing_anchor', 'Расчётная дата'],
            ['billing_timezone', 'Часовой пояс'],
            ['auto_renew', 'Автопродление'],
        ],
        related: [['owner_id', 'Владелец тарифа', 'users']],
        requiresQuery: true,
    },
    families: {
        table: 'families',
        title: 'name',
        status: 'status',
        fields: [
            ['name', 'Название'],
            ['created_at', 'Создана'],
            ['archived_at', 'Архивирована'],
            ['owner_membership_id', 'Членство владельца'],
        ],
        requiresQuery: true,
        note: 'Поиск выполняется по точному UUID семьи. Состав, покрытие и история доступны в связанных коллекциях карточки.',
    },
    payments: {
        table: 'billing_orders',
        title: 'id',
        status: 'status',
        fields: [
            ['amount_minor', 'Сумма в минимальных денежных единицах'],
            ['currency', 'Валюта'],
            ['accepted_at', 'Принятие заказа'],
        ],
        related: [
            ['payer_id', 'Плательщик', 'users'],
            ['recipient_id', 'Получатель', 'users'],
        ],
        note: 'Состояние заказа сохранено в БД. Обновление страницы не запрашивает провайдера и не подтверждает оплату.',
    },
    support: {
        table: 'support_tickets',
        title: 'subject',
        status: 'status',
        fields: [
            ['public_number', 'Номер'],
            ['category', 'Категория'],
            ['closed_at', 'Закрыто'],
        ],
        related: [
            ['requester_id', 'Заявитель', 'users'],
            ['assignee_id', 'Ответственный', 'users'],
        ],
    },
    catalog: {
        table: 'brand_products',
        title: 'name',
        status: 'status',
        fields: [
            ['package_quantity', 'Количество в упаковке'],
            ['package_unit_id', 'Единица упаковки'],
        ],
        note: 'Проекция товаров SKU. Отдельное сравнение кандидатов объединения и вариантов требует своего контракта.',
    },
    news: {
        table: 'announcements',
        title: 'kind',
        status: 'status',
        fields: [
            ['kind', 'Тип'],
            ['revision', 'Редакция'],
            ['publish_at', 'Публикация'],
        ],
        related: [['author_id', 'Автор', 'users']],
        note: 'Статус публикации не означает отправку email.',
    },
    audit: {
        table: 'audit_events',
        title: 'action',
        status: null,
        fields: [
            ['action', 'Действие'],
            ['target_type', 'Тип объекта'],
            ['target_id', 'Объект'],
            ['recorded_at', 'Записано'],
            ['effective_at', 'Действует с'],
            ['request_id', 'ID запроса'],
        ],
        related: [['actor_id', 'Сотрудник', 'users']],
        note: 'Безопасная проекция журнала; произвольные снимки before/after не раскрываются.',
    },
    rollback: {
        table: 'compensation_requests',
        title: 'mode',
        status: 'status',
        fields: [
            ['mode', 'Режим'],
            ['reason', 'Причина'],
            ['applied_at', 'Применение'],
        ],
        related: [['requested_by', 'Инициатор', 'users']],
        note: 'История запросов компенсации. Создание нового отката требует отдельного предварительного просмотра зависимостей.',
    },
    'legal-requests': {
        table: 'legal_requests',
        title: 'kind',
        status: 'status',
        fields: [
            ['kind', 'Тип запроса'],
            ['approved_at', 'Согласован'],
            ['executed_at', 'Исполнен'],
        ],
        related: [
            ['user_id', 'Заявитель', 'users'],
            ['handled_by', 'Ответственный', 'users'],
        ],
    },
    operations: {
        table: 'background_jobs',
        title: 'kind',
        status: 'status',
        fields: [
            ['kind', 'Тип задачи'],
            ['run_at', 'Плановый запуск'],
            ['lease_until', 'Захват до'],
        ],
        note: 'Статус задачи сам по себе не разрешает повтор; payload и секреты не раскрываются.',
    },
    errors: {
        table: 'admin_error_events',
        title: 'code',
        status: 'severity',
        fields: [
            ['occurred_at', 'Время'],
            ['source', 'Источник'],
            ['environment', 'Окружение'],
            ['app_version', 'Версия'],
            ['code', 'Код'],
            ['message', 'Безопасное сообщение'],
            ['stack_summary', 'Санитизированный стек'],
            ['request_id', 'ID запроса'],
        ],
        related: [['job_id', 'Фоновая задача', 'operations']],
    },
    metrics: {
        table: 'admin_metric_events',
        title: 'event_name',
        status: null,
        fields: [
            ['occurred_at', 'Измерено'],
            ['event_name', 'Метрика'],
            ['metric_value', 'Измеренное значение'],
            ['unit', 'Единица'],
            ['environment', 'Окружение'],
            ['app_version', 'Версия'],
            ['plan_code', 'Тариф'],
            ['feature_flag', 'Функция'],
        ],
        note: 'Первичные измерения; не воронка, не конверсия и не оценка отсутствующих данных.',
    },
    access: {
        table: 'users',
        title: 'display_name',
        status: 'status',
        fields: [['login', 'Логин']],
        requiresQuery: true,
        note: 'Поиск аккаунта не выдаёт ему служебные права.',
    },
};
