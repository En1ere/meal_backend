// File-only generation; no live database access. Snapshot from v1 plus explicit migration overlays.
import fs from 'node:fs';
import { format } from 'prettier';
const root = new URL('../', import.meta.url);
const tables = JSON.parse(fs.readFileSync(new URL('database/type-source-v1.json', root), 'utf8'));
let source = `// Generated from database/type-source-v1.json plus migrations 002/004/005/006/007/008/009/010/012/013/014/016/017/018/019/020/021/022/024/025/026/029/030/031 overlays.\nimport type { ColumnType, Generated } from 'kysely';
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Int64 = ColumnType<string, string | number | bigint, string | number | bigint>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type OptionalInsert<T> = T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : Generated<T>;
export interface DatabaseSchema {
    account_mail_deliveries: {
        id: string; account_token_id: string; user_id: string; recipient: string;
        kind: 'verify' | 'reset' | 'email-confirm' | 'email-cancel'; change_id: string | null;
        status: 'queued' | 'processing' | 'accepted' | 'retry_scheduled' | 'unknown' | 'failed' | 'skipped';
        attempts: OptionalInsert<number>; available_at: OptionalInsert<Timestamp>; lease_owner: string | null;
        lease_token: string | null; lease_until: Timestamp | null; message_id: string; provider_reference: string | null;
        last_error_code: string | null; accepted_at: Timestamp | null; completed_at: Timestamp | null;
        created_at: OptionalInsert<Timestamp>; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    account_mail_attempts: {
        id: string; delivery_id: string; attempt_no: number;
        outcome: 'accepted' | 'retry_scheduled' | 'unknown' | 'failed' | 'skipped';
        message_id: string; error_code: string | null; started_at: Timestamp; finished_at: Timestamp;
        created_at: OptionalInsert<Timestamp>;
    };
    acceptance_test_runs: {
        id: string; catalog_version: string; catalog_published_on: string; created_by: string;
        created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    acceptance_test_results: {
        run_id: string; case_id: string; source_checksum: string;
        status: 'not_tested' | 'passed' | 'partial' | 'failed'; comment: OptionalInsert<string>;
        checked_by: string | null; checked_at: Timestamp | null; updated_at: OptionalInsert<Timestamp>;
        version: OptionalInsert<Int64>;
    };
    acceptance_test_events: {
        id: string; run_id: string; case_id: string; source_checksum: string; action: 'updated' | 'reset';
        before_status: 'not_tested' | 'passed' | 'partial' | 'failed';
        after_status: 'not_tested' | 'passed' | 'partial' | 'failed';
        before_comment_hash: string; after_comment_hash: string; result_version: Int64;
        actor_id: string; occurred_at: OptionalInsert<Timestamp>; request_id: string; idempotency_key: string;
    };
    legal_document_publications: {
        document_id: string; content_release_id: string; publish_event_id: string; public_url: string;
        locale: string; jurisdiction: string; approved_at: Timestamp | null; retired_at: Timestamp | null;
        created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    agreement_acceptance_events: {
        id: string; user_id: string; agreement_kind: 'offer'; action: 'accepted'; document_id: string;
        document_version: Int64; body_hash: string; content_release_id: string; publish_event_id: string;
        occurred_at: Timestamp; request_id: string; evidence_mode: 'approved' | 'demonstration'; created_at: OptionalInsert<Timestamp>;
    };
    legal_acknowledgement_events: {
        id: string; user_id: string; document_kind: 'privacy_notice'; action: 'acknowledged'; document_id: string;
        document_version: Int64; body_hash: string; content_release_id: string; publish_event_id: string;
        occurred_at: Timestamp; request_id: string; evidence_mode: 'approved' | 'demonstration'; created_at: OptionalInsert<Timestamp>;
    };
    legal_consent_events: {
        id: string; user_id: string; kind: 'ai_data_access' | 'special_category' | 'dissemination' | 'marketing';
        action: 'accepted' | 'revoked'; revision: Int64; document_snapshot: JsonValue | null; occurred_at: Timestamp;
        request_id: string; idempotency_key: string; evidence_mode: 'approved' | 'demonstration'; created_at: OptionalInsert<Timestamp>;
    };
    worker_leases: {
        task: string; owner_id: string; lease_id: string; fencing_token: Int64;
        acquired_at: Timestamp; expires_at: Timestamp; updated_at: Timestamp; version: OptionalInsert<Int64>;
    };
    scheduled_sanction_effects: {
        id: string; sanction_id: string; kind: 'family_plus_transfer'; recipient_user_id: string | null;
        status: 'scheduled' | 'applied' | 'skipped' | 'failed'; failure_reason: string | null;
        applied_at: Timestamp | null; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    user_critical_grants: {
        id: string; user_id: string; session_id: string; token_hash: string; purpose: 'export' | 'account_lifecycle';
        expires_at: Timestamp; used_at: Timestamp | null; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    export_previews: {
        id: string; user_id: string; scope_id: string | null; selection: JsonValue; manifest: JsonValue;
        expires_at: Timestamp; consumed_at: Timestamp | null; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    chat_mentions: { id: string; message_id: string; user_id: string; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64> };
    recipe_policy: { id: string; submission_daily_limit: number; comment_hourly_limit: number; report_daily_limit: number; version: OptionalInsert<Int64>; updated_at: OptionalInsert<Timestamp> };
    recipe_action_events: { id: string; user_id: string; kind: string; occurred_at: OptionalInsert<Timestamp> };
    auth_rate_limits: { key_hash: string; window_started_at: Timestamp; attempts: number };
    admin_session_unlocks: { id: string; session_id: string; token_hash: string; created_at: OptionalInsert<Timestamp>; expires_at: Timestamp };
    admin_error_events: {
        id: string; occurred_at: Timestamp; source: 'frontend' | 'backend' | 'api' | 'worker';
        severity: 'error' | 'warning' | 'critical'; environment: 'development' | 'test' | 'production';
        app_version: string | null; code: string; message: string; stack_summary: string | null;
        request_id: string | null; job_id: string | null; pseudonymous_id: string | null; version: OptionalInsert<Int64>;
    };
    admin_metric_events: {
        id: string; occurred_at: Timestamp; event_name: string; metric_value: string; unit: 'count' | 'milliseconds';
        environment: 'development' | 'test' | 'production'; app_version: string | null;
        plan_code: 'free' | 'plus' | 'pro' | null; feature_flag: string | null; version: OptionalInsert<Int64>;
    };
    admin_notification_settings: {
        id: string; user_id: string; settings: JsonValue; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    admin_incident_states: {
        id: string; event_id: string; status: 'new' | 'in_progress' | 'resolved' | 'ignored';
        ignored_until: Timestamp | null; reason: string; assigned_to: string | null;
        updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    preserve_containers: {
        id: string; preserve_id: string; label: string; initial_quantity: string | null;
        remaining_quantity: string | null; opened_at: Timestamp | null; opened_on: string | null; depleted_at: Timestamp | null;
        created_at: OptionalInsert<Timestamp>; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    recommendation_issuances: {
        id: string; user_id: string; recommendation_id: string; entity_type: 'recipe' | 'author'; entity_key: string;
        algorithm: 'personalized-v1'; surface: 'home' | 'recipes' | 'authors'; position: number; reason_codes: JsonValue;
        created_at: OptionalInsert<Timestamp>; expires_at: Timestamp; version: OptionalInsert<Int64>;
    };
    recommendation_events: {
        id: string; user_id: string; recommendation_id: string;
        event_kind: 'impression' | 'open' | 'not_interested' | 'not_suitable'; entity_type: 'recipe' | 'author';
        entity_key: string; algorithm: 'personalized-v1'; surface: 'home' | 'recipes' | 'authors'; position: number | null;
        reason_codes: OptionalInsert<JsonValue>; payload_hash: string; idempotency_key: string;
        occurred_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    allergen_icons: {
        id: string; allergen_id: string; state: 'fallback' | 'ready' | 'unavailable' | 'rejected'; fallback_key: string;
        alt_text: string; asset_id: string | null; updated_by: string; created_at: OptionalInsert<Timestamp>;
        version: OptionalInsert<Int64>;
    };
    allergen_mappings: {
        id: string; allergen_id: string; ingredient_id: string | null; variant_id: string | null; product_id: string | null;
        status: 'contains' | 'may_contain' | 'unknown'; source: string; created_by: string; removed_at: Timestamp | null;
        created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    allergen_reports: {
        id: string; user_id: string; recipe_id: string; revision_id: string; unknown_ingredient_ids: JsonValue;
        note: string; ticket_id: string; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    announcement_versions: {
        id: string; announcement_id: string; revision: number; content: JsonValue; created_by: string;
        created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    announcement_reads: {
        id: string; announcement_id: string; announcement_version_id: string; user_id: string; idempotency_key: string;
        read_at: OptionalInsert<Timestamp>; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    content_releases: {
        id: string; name: string; status: 'draft' | 'published'; revision: OptionalInsert<number>; source_release_id: string | null;
        rolled_back_from_event_id: string | null; client_revision: Int64 | null; client_checksum: string | null; created_by: string; published_by: string | null; published_at: Timestamp | null;
        created_at: OptionalInsert<Timestamp>; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    content_release_patches: {
        id: string; release_id: string; ordinal: number; resource_type: 'achievement' | 'reputation_title' | 'legal_text' | 'product_description' | 'content_document' | 'dictionary_entry';
        action: 'create' | 'update' | 'retire'; resource_key: string; expected_version: Int64; payload: JsonValue | null;
        created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    content_release_events: {
        id: string; release_id: string; kind: 'published' | 'rolled_back'; snapshot: JsonValue; inverse_snapshot: JsonValue;
        created_by: string; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    content_resource_heads: {
        resource_type: 'achievement' | 'reputation_title' | 'legal_text' | 'product_description' | 'content_document' | 'dictionary_entry'; resource_key: string;
        payload: JsonValue | null; retired: OptionalInsert<boolean>; published_release_id: string;
        created_at: OptionalInsert<Timestamp>; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    reputation_titles: {
        id: string; level: number; threshold: Int64; title: string; published_release_id: string;
        created_at: OptionalInsert<Timestamp>; updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    product_descriptions: {
        product_id: string; description: string; published_release_id: string; created_at: OptionalInsert<Timestamp>;
        updated_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
    reputation_rule_versions: {
        id: string; code: string; revision: number; points: number; per_subject_cap: number | null; condition: JsonValue;
        enabled: boolean; published_release_id: string; created_at: OptionalInsert<Timestamp>; version: OptionalInsert<Int64>;
    };
`;
for (const table of tables) {
    source += `'${table.name}': {\n`;
    if (table.name === 'recipe_revisions')
        source +=
            'description: OptionalInsert<string | null>; category: OptionalInsert<string | null>; image_url: OptionalInsert<string | null>; tags: OptionalInsert<string[]>;\n';
    if (table.name === 'recipe_bookmarks') source += 'removed_at: OptionalInsert<Timestamp | null>;\n';
    if (table.name === 'author_follows') source += 'removed_at: OptionalInsert<Timestamp | null>;\n';
    if (table.name === 'inventory_batches') source += 'metadata: OptionalInsert<JsonValue>;\n';
    if (table.name === 'shopping_lists') source += "archived_from: OptionalInsert<'active' | 'completed' | null>;\n";
    if (table.name === 'shopping_items')
        source +=
            'position: OptionalInsert<number>; estimated_price_minor: OptionalInsert<Int64 | null>; origin_snapshot: OptionalInsert<JsonValue>;\n';
    if (table.name === 'receipts') source += 'linked_purchase_id: OptionalInsert<string | null>;\n';
    if (table.name === 'purchase_lines') source += 'shopping_item_id: OptionalInsert<string | null>;\n';
    if (table.name === 'preserve_details')
        source += 'created_on: string; ingredients_snapshot: OptionalInsert<JsonValue>;\n';
    if (table.name === 'cooking_inputs') source += 'container_id: OptionalInsert<string | null>;\n';
    if (table.name === 'sanctions')
        source += 'category: OptionalInsert<string | null>; private_note: OptionalInsert<string | null>;\n';
    if (table.name === 'sessions')
        source +=
            'admin_critical_until: OptionalInsert<Timestamp | null>; admin_mfa_failures: OptionalInsert<number>;\n';
    if (table.name === 'account_tokens') source += 'cipher_key_version: OptionalInsert<number>;\n';
    if (table.name === 'account_devices') source += 'expires_at: Timestamp;\n';
    if (table.name === 'export_jobs') source += 'idempotency_key: string | null;\n';
    if (table.name === 'payment_attempts')
        source += 'request_hash: string | null; checkout_url: string | null; provider_occurred_at: Timestamp | null;\n';
    if (table.name === 'payment_refunds')
        source +=
            "idempotency_key: string | null; request_hash: string | null; access_effect: OptionalInsert<'preserve' | 'terminate'>; access_target_kind: 'subscription_period' | 'ai_package' | null; access_target_id: string | null; provider_event_id: string | null; consequence_applied_at: Timestamp | null;\n";
    if (table.name === 'legal_requests')
        source +=
            'idempotency_key: string | null; requested_at: OptionalInsert<Timestamp>; cancel_until: Timestamp | null; cancelled_at: Timestamp | null; finalization_not_before: Timestamp | null; policy_version: string | null; blocker_snapshot: OptionalInsert<JsonValue>;\n';
    if (table.name === 'achievement_rules')
        source +=
            'title: string | null; description: string | null; icon_metadata: JsonValue | null; reputation_delta: OptionalInsert<number>; secret: OptionalInsert<boolean>; retired_at: Timestamp | null; published_release_id: string | null;\n';
    if (table.name === 'achievement_awards') source += 'achievement_key: string;\n';
    if (['sessions', 'auth_challenges'].includes(table.name))
        source += "auth_context: 'user' | 'admin' | 'moderator' | null;\n";
    if (table.name === 'auth_challenges') source += 'factor_id: string | null; revoked_at: Timestamp | null;\n';
    for (const column of table.columns) {
        let type =
            column.type === 'timestamptz'
                ? 'Timestamp'
                : column.type === 'bigint'
                  ? 'Int64'
                  : /^(smallint|integer)$/.test(column.type)
                    ? 'number'
                    : column.type === 'boolean'
                      ? 'boolean'
                      : column.type === 'jsonb'
                        ? 'JsonValue'
                        : 'string';
        if (column.nullable) type += ' | null';
        if (column.default !== undefined || column.extra?.includes('DEFAULT')) type = `OptionalInsert<${type}>`;
        source += `'${column.name}': ${type};\n`;
    }
    source += '};\n';
}
source += '}\n';
const config = JSON.parse(fs.readFileSync(new URL('.prettierrc.json', root), 'utf8'));
const output = await format(source, { ...config, parser: 'typescript' });
const target = new URL('src/infrastructure/database/schema.generated.ts', root);
if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output)
        throw Error('Generated database types are stale');
} else fs.writeFileSync(target, output);
