import { HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../../shared/config/app-config.js';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { DatabaseSchema } from '../../infrastructure/database/schema.generated.js';
import type { Principal } from '../auth/auth.service.js';
import { AdminAccessService } from '../admin-auth/public.js';
import {
    runtimeSettingsTabSchema,
    webPushPolicyExecuteSchema,
    webPushPolicyInputSchema,
    type WebPushPolicyInput,
} from './admin-runtime-settings.contracts.js';
import { LocalBackupStatusReader } from './local-backup-status.reader.js';

const tabs = [
    ['notifications', 'Уведомления'],
    ['mail', 'Почта'],
    ['storage', 'Хранилище и OCR'],
    ['security', 'Безопасность'],
    ['deploy_backup', 'Деплой и backup'],
    ['backup_recovery', 'Recovery-доступ'],
    ['integrations', 'Интеграции'],
    ['legal', 'Юридические данные'],
] as const;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value?: string) => (value ? `sha256:${sha(value).slice(0, 12)}` : null);
type Policy = WebPushPolicyInput & { version: number; updatedAt: string };

@Injectable()
export class AdminRuntimeSettingsService {
    constructor(
        private readonly database: DatabaseService,
        private readonly access: AdminAccessService,
        private readonly localBackup: LocalBackupStatusReader,
        @Inject(APP_CONFIG) private readonly config: AppConfig,
    ) {}
    private async db() {
        if (!this.database.db || !(await this.database.ready())) throw new ServiceUnavailableException();
        return this.database.db;
    }
    private async policy(db: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>): Promise<Policy> {
        const result = await sql<{
            quiet_start: string;
            quiet_end: string;
            critical_ttl: number;
            important_ttl: number;
            informational_ttl: number;
            marketing_ttl: number;
            version: string;
            updated_at: Date;
        }>`
          select quiet_start::text,quiet_end::text,critical_ttl,important_ttl,informational_ttl,marketing_ttl,version,updated_at from meal.web_push_policies where id=1`.execute(
            db,
        );
        const row = result.rows[0]!;
        return {
            quietHours: { start: row.quiet_start.slice(0, 5), end: row.quiet_end.slice(0, 5) },
            ttlSeconds: {
                critical: row.critical_ttl,
                important: row.important_ttl,
                informational: row.informational_ttl,
                marketing: row.marketing_ttl,
            },
            expectedVersion: Number(row.version),
            version: Number(row.version),
            updatedAt: row.updated_at.toISOString(),
        };
    }
    async read(rawTab: unknown) {
        const selectedTab = runtimeSettingsTabSchema.parse(rawTab ?? 'notifications');
        const db = await this.db();
        const policy = await this.policy(db);
        const localBackup = await this.localBackup.read();
        const localBackupData = localBackup.availability === 'available' ? localBackup.data : null;
        const lastSuccessAgeSeconds = localBackupData?.lastSuccessAt
            ? Math.max(0, Math.floor((Date.now() - Date.parse(localBackupData.lastSuccessAt)) / 1_000))
            : null;
        const localBackupBlockers = ['offsite_target_missing'];
        if (!localBackupData)
            localBackupBlockers.unshift(
                `local_backup_status_${localBackup.availability === 'unavailable' ? localBackup.reason : 'invalid'}`,
            );
        else {
            if (localBackupData.state === 'failed')
                localBackupBlockers.unshift(localBackupData.failureCode ?? 'local_backup_failed');
            if (lastSuccessAgeSeconds === null) localBackupBlockers.unshift('local_backup_missing');
            else if (lastSuccessAgeSeconds > localBackupData.policy.rpoSeconds)
                localBackupBlockers.unshift('local_backup_rpo_exceeded');
            if (localBackupData.restoreDrill.outcome !== 'passed')
                localBackupBlockers.unshift('local_backup_restore_unproven');
        }
        const localBackupHealthy =
            localBackupData?.state === 'ok' &&
            lastSuccessAgeSeconds !== null &&
            lastSuccessAgeSeconds <= localBackupData.policy.rpoSeconds &&
            localBackupData.restoreDrill.outcome === 'passed';
        const historyRows = await sql<{
            at: Date;
            actor: string;
        }>`select e.recorded_at at,coalesce(u.login,'system') actor from meal.audit_events e left join meal.users u on u.id=e.actor_id where e.action='admin.runtime-settings.web-push-policy.updated' order by e.recorded_at desc,e.id desc limit 20`.execute(
            db,
        );
        const policyHistory = historyRows.rows.map((row) => ({
            at: row.at.toISOString(),
            actor: row.actor,
            summary: 'Web Push policy updated',
        }));
        const base = (entry: Record<string, unknown> & { tab: string }): Record<string, unknown> & { tab: string } => ({
            description: '',
            status: 'disabled',
            source: 'environment',
            readiness: 'disabled',
            editable: false,
            sensitive: false,
            updatedAt: null,
            version: null,
            blockers: [],
            affectedServices: [],
            checks: [],
            instruction: null,
            history: [],
            secret: null,
            policy: null,
            ...entry,
        });
        const all = [
            base({
                tab: 'notifications',
                key: 'web-push-policy',
                label: 'Web Push policy',
                description: 'Тихие часы и TTL по приоритету',
                value: this.config.WEB_PUSH_ENABLED ? 'enabled' : 'disabled',
                status: this.config.WEB_PUSH_ENABLED ? 'active' : 'disabled',
                source: 'database',
                readiness: this.config.WEB_PUSH_ENABLED ? 'ready' : 'owner_input',
                editable: true,
                updatedAt: policy.updatedAt,
                version: policy.version,
                affectedServices: ['backend', 'push-worker', 'frontend'],
                checks: ['VAPID', 'subscription encryption', '404/410 cleanup'],
                policy: { quietHours: policy.quietHours, ttlSeconds: policy.ttlSeconds, version: policy.version },
                history: policyHistory,
                blockers: this.config.WEB_PUSH_ENABLED ? [] : ['vapid_keys_missing'],
            }),
            base({
                tab: 'notifications',
                key: 'vapid-private-key',
                label: 'VAPID private key',
                value: this.config.WEB_PUSH_VAPID_PRIVATE_KEY ? 'configured' : 'missing',
                status: this.config.WEB_PUSH_VAPID_PRIVATE_KEY ? 'active' : 'blocked',
                source: 'vps_secret',
                readiness: this.config.WEB_PUSH_VAPID_PRIVATE_KEY ? 'ready' : 'owner_input',
                sensitive: true,
                affectedServices: ['push-worker'],
                checks: ['root-owned secret'],
                instruction: 'Сгенерировать ключ и загрузить через root-owned secret file.',
                secret: {
                    configured: !!this.config.WEB_PUSH_VAPID_PRIVATE_KEY,
                    fingerprint: fingerprint(this.config.WEB_PUSH_VAPID_PRIVATE_KEY),
                    rotatedAt: null,
                },
            }),
            base({
                tab: 'mail',
                key: 'account-mail',
                label: 'Транзакционная почта',
                value: this.config.ACCOUNT_MAIL_ENABLED ? 'enabled' : 'disabled',
                status: this.config.ACCOUNT_MAIL_ENABLED ? 'active' : 'blocked',
                readiness: this.config.ACCOUNT_MAIL_ENABLED ? 'ready' : 'owner_input',
                blockers: this.config.ACCOUNT_MAIL_ENABLED ? [] : ['smtp_credentials_missing'],
                affectedServices: ['mail-worker'],
            }),
            base({
                tab: 'storage',
                key: 'media-storage',
                label: 'Media storage',
                value: this.config.MEDIA_STORAGE_ENABLED ? 'enabled' : 'disabled',
                status: this.config.MEDIA_STORAGE_ENABLED ? 'active' : 'partial',
                readiness: this.config.MEDIA_STORAGE_ENABLED ? 'external_dependency' : 'disabled',
                affectedServices: ['backend', 'media-processor'],
                checks: ['scanner gate'],
            }),
            base({
                tab: 'storage',
                key: 'ocr-preview',
                label: 'OCR preview',
                value: this.config.INLINE_INGEST_OCR_ENABLED ? 'enabled' : 'disabled',
                status: this.config.INLINE_INGEST_OCR_ENABLED ? 'active' : 'disabled',
                readiness: this.config.INLINE_INGEST_OCR_ENABLED ? 'ready' : 'disabled',
                affectedServices: ['backend', 'ocr-preview'],
            }),
            base({
                tab: 'security',
                key: 'registration-risk',
                label: 'Registration risk',
                value: this.config.REGISTRATION_RISK_ENABLED ? 'enabled' : 'disabled',
                status: this.config.REGISTRATION_RISK_ENABLED ? 'active' : 'disabled',
                readiness: 'ready',
                affectedServices: ['backend'],
            }),
            base({
                tab: 'deploy_backup',
                key: 'deployment',
                label: 'Immutable Docker deploy',
                value: 'configured',
                status: 'active',
                source: 'derived',
                readiness: 'ready',
                affectedServices: ['backend', 'frontend', 'admin'],
                checks: ['digest pinning', 'health verification', 'bounded lock'],
            }),
            base({
                tab: 'deploy_backup',
                key: 'local-backup',
                label: 'Локальный encrypted backup',
                description: 'Restic snapshot PostgreSQL, media и allowlisted manifests на текущем VPS',
                value: localBackupData ? 'encrypted · local only' : 'not configured',
                status: localBackupHealthy ? 'active' : localBackupData ? 'partial' : 'blocked',
                source: 'derived',
                readiness: localBackupHealthy ? 'external_dependency' : 'disabled',
                sensitive: true,
                updatedAt: localBackupData?.observedAt ?? null,
                version: localBackupData?.schemaVersion ?? null,
                blockers: [...new Set(localBackupBlockers)],
                affectedServices: ['postgres', 'media-storage', 'backend'],
                checks: localBackupData
                    ? [
                          `${localBackupData.schedule.localTime} ${localBackupData.schedule.timezone}`,
                          `${localBackupData.retention.daily} daily + ${localBackupData.retention.weekly} weekly`,
                          `RPO ${localBackupData.policy.rpoSeconds / 3_600}h / RTO ${localBackupData.policy.rtoSeconds / 3_600}h`,
                          `last success: ${localBackupData.lastSuccessAt ?? 'never'}`,
                          `restore drill: ${localBackupData.restoreDrill.outcome}`,
                          'authenticated encryption',
                      ]
                    : ['status file unavailable', 'offsite=false'],
                instruction:
                    'Локальный repository защищает от логических ошибок, но не от потери VPS. Инструкция по recovery password находится во вкладке «Recovery-доступ»; offsite target требуется отдельно.',
                history: [
                    ...(localBackupData?.lastSuccessAt
                        ? [
                              {
                                  at: localBackupData.lastSuccessAt,
                                  actor: 'systemd',
                                  summary: 'Local backup completed',
                              },
                          ]
                        : []),
                    ...(localBackupData?.restoreDrill.observedAt
                        ? [
                              {
                                  at: localBackupData.restoreDrill.observedAt,
                                  actor: 'operations',
                                  summary: `Restore drill ${localBackupData.restoreDrill.outcome}`,
                              },
                          ]
                        : []),
                ].slice(0, 20),
                secret: {
                    configured: localBackupData?.recoveryKeyConfigured ?? false,
                    fingerprint: null,
                    rotatedAt: null,
                },
            }),
            base({
                tab: 'deploy_backup',
                key: 'offsite-backup',
                label: 'Offsite backup',
                value: 'missing',
                status: 'blocked',
                source: 'environment',
                readiness: 'owner_input',
                blockers: ['offsite_target_missing'],
                affectedServices: ['postgres', 'media-storage'],
            }),
            base({
                tab: 'backup_recovery',
                key: 'local-backup-recovery-access',
                label: 'Recovery-доступ к локальному backup',
                description: 'Где получить, как независимо сохранить и как безопасно ротировать recovery password',
                value: localBackupData?.recoveryKeyConfigured
                    ? 'ключ настроен на VPS · независимая копия не подтверждена'
                    : 'ключ недоступен',
                status: localBackupData?.recoveryKeyConfigured ? 'partial' : 'blocked',
                source: 'vps_secret',
                readiness: 'owner_input',
                sensitive: true,
                updatedAt: localBackupData?.observedAt ?? null,
                blockers: [
                    ...(localBackupData?.recoveryKeyConfigured ? [] : ['recovery_password_missing']),
                    'offline_recovery_copy_unconfirmed',
                ],
                affectedServices: ['restic', 'local-backup'],
                checks: [
                    'password file: /etc/meal-planner/secrets/local-backup-password',
                    'repository: /var/backups/meal-planner/local-restic',
                    'root:root 0600',
                    'значение не передаётся в admin API',
                    'Bitwarden, 1Password или эквивалентная encrypted secure note',
                    'никаких Git, .env, email, чатов или plaintext-копий',
                    'rotation: restic key add → exact readback → isolated restore drill → удалить старый key',
                ],
                instruction:
                    'Подключитесь к текущему VPS по SSH под root и выполните: cat /etc/meal-planner/secrets/local-backup-password. Сохраните значение в защищённой заметке с названием «Meal Planner — restic recovery password», адресом текущего VPS, repository /var/backups/meal-planner/local-restic и датой. Admin не получает значение и не может подтвердить независимую копию. Не редактируйте password file вручную: ротация выполняется только через restic key management с проверенным snapshot и isolated restore drill до удаления старого key.',
                secret: {
                    configured: localBackupData?.recoveryKeyConfigured ?? false,
                    fingerprint: null,
                    rotatedAt: null,
                },
            }),
            base({
                tab: 'integrations',
                key: 'ai-provider',
                label: 'AI provider',
                value: this.config.AI_BACKGROUND_EXECUTION_ENABLED ? 'worker enabled' : 'disabled',
                status: this.config.AI_BACKGROUND_EXECUTION_ENABLED ? 'partial' : 'blocked',
                source: 'environment',
                readiness: this.config.AI_BACKGROUND_EXECUTION_ENABLED ? 'external_dependency' : 'owner_input',
                sensitive: true,
                affectedServices: ['backend', 'ai-worker'],
                instruction:
                    'Секрет провайдера доступен только изолированному ai-worker и не передаётся backend/admin API. Проверяйте наличие файла /etc/meal-planner/secrets/ai-api-token через SSH на VPS.',
                secret: {
                    configured: this.config.AI_BACKGROUND_EXECUTION_ENABLED,
                    fingerprint: null,
                    rotatedAt: null,
                },
            }),
            base({
                tab: 'legal',
                key: 'legal-package',
                label: 'Юридические документы',
                value: '[Тут будут данные]',
                status: 'blocked',
                source: 'database',
                readiness: 'owner_input',
                blockers: ['legal_identity_missing'],
                affectedServices: ['backend', 'frontend'],
            }),
        ];
        return {
            generatedAt: new Date().toISOString(),
            completeness: 'complete' as const,
            unavailableSources: [],
            tabs: tabs.map(([code, label]) => ({ code, label })),
            selectedTab,
            entries: all
                .filter((x) => x.tab === selectedTab)
                .map((entry) => {
                    const { tab, ...value } = entry;
                    void tab;
                    return value;
                }),
        };
    }
    async preview(actor: Principal, raw: unknown) {
        const input = webPushPolicyInputSchema.parse(raw);
        await this.db();
        return this.database.transaction(async (tx) => {
            const current = await this.policy(tx);
            if (current.version !== input.expectedVersion) throw new HttpException('Policy changed', 412);
            const payload = {
                quietHours: input.quietHours,
                ttlSeconds: input.ttlSeconds,
                expectedVersion: input.expectedVersion,
            };
            const previewId = randomUUID();
            const expiresAt = new Date(Date.now() + 10 * 60_000);
            await sql`insert into meal.runtime_setting_previews(id,actor_id,actor_session_id,setting_key,expected_version,payload,payload_hash,expires_at) values(${previewId}::uuid,${actor.id}::uuid,${actor.sessionId}::uuid,'web_push.policy',${input.expectedVersion},${JSON.stringify(payload)}::jsonb,${sha(JSON.stringify(payload))},${expiresAt})`.execute(
                tx,
            );
            const changes = [
                ['quietHours.start', current.quietHours.start, input.quietHours.start],
                ['quietHours.end', current.quietHours.end, input.quietHours.end],
                ['ttlSeconds.critical', current.ttlSeconds.critical, input.ttlSeconds.critical],
                ['ttlSeconds.important', current.ttlSeconds.important, input.ttlSeconds.important],
                ['ttlSeconds.informational', current.ttlSeconds.informational, input.ttlSeconds.informational],
                ['ttlSeconds.marketing', current.ttlSeconds.marketing, input.ttlSeconds.marketing],
            ]
                .filter(([, from, to]) => from !== to)
                .map(([field, from, to]) => ({ field: String(field), from: String(from), to: String(to) }));
            return {
                previewId,
                expiresAt: expiresAt.toISOString(),
                changes,
                policy: { quietHours: input.quietHours, ttlSeconds: input.ttlSeconds, version: input.expectedVersion },
            };
        });
    }
    execute(actor: Principal, raw: unknown) {
        const input = webPushPolicyExecuteSchema.parse(raw);
        return this.database.transaction(async (tx) => {
            await this.access.assertAdminRole(tx, actor);
            await this.access.assertCritical(tx, actor);
            const requestHash = sha(JSON.stringify(input));
            const replay = await tx
                .selectFrom('idempotency_records')
                .select(['request_hash', 'response_snapshot'])
                .where('actor_namespace', '=', `admin:${actor.id}`)
                .where('operation', '=', 'admin.runtime-settings.web-push-policy')
                .where('target_binding', '=', 'web_push.policy')
                .where('key', '=', input.idempotencyKey)
                .executeTakeFirst();
            if (replay) {
                if (replay.request_hash !== requestHash) throw new HttpException('Idempotency key conflict', 409);
                return replay.response_snapshot;
            }
            const payload = {
                quietHours: input.quietHours,
                ttlSeconds: input.ttlSeconds,
                expectedVersion: input.expectedVersion,
            };
            const preview = await sql<{
                payload_hash: string;
            }>`select payload_hash from meal.runtime_setting_previews where id=${input.previewId}::uuid and actor_id=${actor.id}::uuid and actor_session_id=${actor.sessionId}::uuid and setting_key='web_push.policy' and expected_version=${input.expectedVersion} and consumed_at is null and expires_at>now() for update`.execute(
                tx,
            );
            if (preview.rows[0]?.payload_hash !== sha(JSON.stringify(payload)))
                throw new HttpException('Preview missing, expired or changed', 409);
            const updated = await sql<{
                version: string;
                updated_at: Date;
            }>`update meal.web_push_policies set quiet_start=${input.quietHours.start}::time,quiet_end=${input.quietHours.end}::time,critical_ttl=${input.ttlSeconds.critical},important_ttl=${input.ttlSeconds.important},informational_ttl=${input.ttlSeconds.informational},marketing_ttl=${input.ttlSeconds.marketing},updated_at=now(),updated_by=${actor.id}::uuid,version=version+1 where id=1 and version=${input.expectedVersion} returning version,updated_at`.execute(
                tx,
            );
            if (!updated.rows[0]) throw new HttpException('Policy changed', 412);
            await sql`update meal.runtime_setting_previews set consumed_at=now() where id=${input.previewId}::uuid`.execute(
                tx,
            );
            const result = {
                policy: {
                    quietHours: input.quietHours,
                    ttlSeconds: input.ttlSeconds,
                    version: Number(updated.rows[0].version),
                },
                updatedAt: updated.rows[0].updated_at.toISOString(),
            };
            await tx
                .insertInto('audit_events')
                .values({
                    id: randomUUID(),
                    action: 'admin.runtime-settings.web-push-policy.updated',
                    target_type: 'runtime_setting',
                    target_id: input.previewId,
                    effective_at: updated.rows[0].updated_at,
                    recorded_at: updated.rows[0].updated_at,
                    reason: null,
                    before_redacted: null,
                    after_redacted: {
                        quietHours: input.quietHours,
                        ttlSeconds: input.ttlSeconds,
                        version: Number(updated.rows[0].version),
                    },
                    request_id: input.idempotencyKey,
                    actor_id: actor.id,
                    scope_id: null,
                })
                .execute();
            await tx
                .insertInto('idempotency_records')
                .values({
                    id: randomUUID(),
                    operation: 'admin.runtime-settings.web-push-policy',
                    target_binding: 'web_push.policy',
                    key: input.idempotencyKey,
                    request_hash: requestHash,
                    status: 'completed',
                    response_snapshot: result,
                    expires_at: sql`'infinity'::timestamptz`,
                    user_id: actor.id,
                    scope_id: null,
                    actor_namespace: `admin:${actor.id}`,
                })
                .execute();
            return result;
        });
    }
}
