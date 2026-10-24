import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { generateSync } from 'otplib';
import { createApp, openApiDocument } from '../dist/src/app/create-app.js';
import { readConfig } from '../dist/src/app/config.js';
import { errorEnvelopeSchema } from '../dist/src/shared/http/openapi-responses.js';
import { PersonalizationService } from '../dist/src/modules/personalization/personalization.service.js';
import { AiService } from '../dist/src/modules/ai/ai.service.js';
import { SubscriptionSettingsService } from '../dist/src/modules/subscription-settings/subscription-settings.service.js';
import { ProOverviewService } from '../dist/src/modules/pro-overview/pro-overview.service.js';
import { AccountLifecycleService } from '../dist/src/modules/account-lifecycle/account-lifecycle.service.js';
import { FamilyService } from '../dist/src/modules/family/family.service.js';
import { runShoppingReceiptsAcceptance } from './acceptance/shopping-receipts.mjs';
import { runPlanningPreservesCookingAcceptance } from './acceptance/planning-preserves-cooking.mjs';
import { runAdminDomainAcceptance } from './acceptance/admin-domain.mjs';
import { runAiProDomainAcceptance } from './acceptance/ai-pro-domain.mjs';
import { runRemainingDomainsAcceptance } from './acceptance/remaining-domains.mjs';
import { runQueryOptimizationsAcceptance } from './acceptance/query-optimizations.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL for the isolated PostgreSQL acceptance database');
const ownerConnectionString = process.env.ACCEPTANCE_OWNER_DATABASE_URL;
if (!ownerConnectionString) throw new Error('Set ACCEPTANCE_OWNER_DATABASE_URL for isolated fixture preparation');
const target = new URL(connectionString);
const ownerTarget = new URL(ownerConnectionString);
if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(target.hostname) ||
    target.pathname !== '/meal_planner_postgres' ||
    decodeURIComponent(target.username) !== 'meal_app'
)
    throw new Error('Live PostgreSQL acceptance requires local meal_app@meal_planner_postgres');
if (
    !['postgres:', 'postgresql:'].includes(ownerTarget.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(ownerTarget.hostname) ||
    ownerTarget.pathname !== '/meal_planner_postgres' ||
    decodeURIComponent(ownerTarget.username) !== 'meal_owner'
)
    throw new Error('Fixture preparation requires local meal_owner@meal_planner_postgres');

const manifest = JSON.parse(fs.readFileSync(new URL('../database/manifest.json', import.meta.url), 'utf8'));
const pool = new pg.Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 3000,
    options: '-c timezone=UTC -c search_path=meal,public',
});
const ownerPool = new pg.Pool({
    connectionString: ownerConnectionString,
    max: 1,
    connectionTimeoutMillis: 3000,
    options: '-c timezone=UTC -c search_path=meal,public',
});
const expectPgCode = async (code, operation) => {
    try {
        await operation();
        assert.fail(`Expected PostgreSQL ${code}`);
    } catch (error) {
        assert.equal(error?.code, code);
    }
};

let app;
try {
    const targetState = await pool.query(`select
      current_database() as database,
      current_user as role,
      current_setting('server_version_num')::int / 10000 as major,
      current_setting('timezone') as timezone,
      (select name from meal.environment) as environment,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='meal' and c.relkind in ('r','p')) as tables,
      (select count(*)::int from pg_constraint c join pg_namespace n on n.oid=c.connamespace
        where n.nspname='meal' and c.contype='f') as foreign_keys,
      not (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolbypassrls) as role_safe,
      has_schema_privilege(current_user,'meal','USAGE') as schema_usage,
      has_schema_privilege(current_user,'meal','CREATE') as schema_create,
      has_table_privilege(current_user,'meal.users','DELETE') as users_delete,
      has_table_privilege(current_user,'meal.scheduled_sanction_effects','SELECT,INSERT') as scheduled_read_insert,
      has_column_privilege(current_user,'meal.scheduled_sanction_effects','status','UPDATE') as scheduled_status_update,
      has_table_privilege(current_user,'meal.scheduled_sanction_effects','DELETE') as scheduled_delete,
      has_column_privilege(current_user,'meal.notification_preferences','urgent_opt_in','UPDATE') as notification_urgent_update
      from pg_roles r where r.rolname=current_user`);
    assert.deepEqual(targetState.rows[0], {
        database: 'meal_planner_postgres',
        role: 'meal_app',
        major: 18,
        timezone: 'UTC',
        environment: 'test',
        tables: manifest.totalTables,
        foreign_keys: manifest.foreignKeys,
        role_safe: true,
        schema_usage: true,
        schema_create: false,
        users_delete: false,
        scheduled_read_insert: true,
        scheduled_status_update: true,
        scheduled_delete: false,
        notification_urgent_update: true,
    });

    const history = await pool.query('select version,checksum from meal.schema_migrations order by version');
    assert.deepEqual(
        history.rows.map((row) => ({ version: Number(row.version), sha256: row.checksum })),
        manifest.migrations.map(({ version, sha256 }) => ({ version, sha256 })),
    );
    await expectPgCode('42501', () => pool.query('create table meal.acceptance_forbidden(id integer)'));
    await expectPgCode('42501', () => pool.query('delete from meal.users where false'));

    const config = readConfig({
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '3001',
        FRONTEND_ORIGIN: 'http://localhost:3000',
        ADMIN_FRONTEND_ORIGIN: 'http://localhost:3002',
        DATABASE_URL: connectionString,
        DATABASE_POOL_SIZE: '2',
        LOG_LEVEL: 'silent',
        SECURITY_KEY: randomBytes(32).toString('base64'),
        MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        REGISTRATION_RISK_ENABLED: 'false',
    });
    app = await createApp(config);
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);

    const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
    assert.equal(csrf.statusCode, 200);
    const cookies = new Map(csrf.cookies.map((cookie) => [cookie.name, cookie.value]));
    const csrfToken = csrf.json().data.token;
    const headers = () => ({
        origin: config.FRONTEND_ORIGIN,
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        'x-csrf-token': csrfToken,
    });
    const suffix = randomBytes(6).toString('hex');
    const email = `acceptance-${suffix}@example.test`;
    const registration = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: headers(),
        payload: {
            username: `accept_${suffix}`,
            displayName: 'PostgreSQL Acceptance',
            email,
            password: 'AcceptancePassword1!',
            acceptTerms: true,
            acceptPrivacy: true,
        },
    });
    assert.equal(registration.statusCode, 200, registration.body);

    const mailbox = await app.inject({
        method: 'POST',
        url: '/api/v1/dev/mailbox',
        headers: headers(),
        payload: { email },
    });
    assert.equal(mailbox.statusCode, 200, mailbox.body);
    const verificationToken = mailbox.json().data.messages.find((message) => message.kind === 'verify')?.token;
    assert.match(verificationToken ?? '', /^[A-Za-z0-9_-]{43}$/);
    const verification = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email/verify',
        headers: headers(),
        payload: { token: verificationToken },
    });
    assert.equal(verification.statusCode, 200, verification.body);

    const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: headers(),
        payload: { email, password: 'AcceptancePassword1!' },
    });
    assert.equal(login.statusCode, 200, login.body);
    for (const cookie of login.cookies) cookies.set(cookie.name, cookie.value);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: headers().cookie } });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().data.user.displayName, 'PostgreSQL Acceptance');

    const userId = me.json().data.user.id;
    const firstUserSessionId = me.json().data.user.sessionId;
    const get = (url, remoteAddress) =>
        app.inject({
            method: 'GET',
            url,
            headers: { cookie: headers().cookie },
            ...(remoteAddress ? { remoteAddress } : {}),
        });
    const entitlement = async (plan, source, remoteAddress) => {
        const response = await get('/api/v1/entitlements', remoteAddress);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().data.plan, plan);
        assert.equal(response.json().data.source, source);
        return response.json().data;
    };
    const addSubscription = async (code, grantKind) => {
        const client = await pool.connect();
        const subscriptionId = randomUUID();
        const periodId = randomUUID();
        try {
            await client.query('begin isolation level serializable');
            const product = await client.query('select id from meal.billing_products where code=$1', [code]);
            assert.equal(product.rows.length, 1, `${code} billing fixture`);
            await client.query(
                `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
                 values($1,'active',false,now(),'Europe/Moscow',$2,$3)`,
                [subscriptionId, userId, product.rows[0].id],
            );
            await client.query(
                `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
                 values($1,now()-interval '1 day',now()+interval '30 days',$2,null,$3)`,
                [periodId, grantKind, subscriptionId],
            );
            await client.query('commit');
            return { subscriptionId, periodId };
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };
    const expirePeriod = async (periodId) => {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `update meal.subscription_periods
                 set starts_at=now()-interval '60 days',ends_at=now()-interval '30 days',version=version+1
                 where id=$1`,
                [periodId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };
    const familyCreate = (name) =>
        app.inject({
            method: 'POST',
            url: '/api/v1/family',
            headers: headers(),
            payload: { name, idempotencyKey: randomUUID() },
        });
    const legalDocument = async (kind) => {
        const response = await get('/api/v1/legal/manifest');
        assert.equal(response.statusCode, 200, response.body);
        const document = response.json().data.documents.find((item) => item.kind === kind)?.document;
        assert.ok(document, `${kind} legal document`);
        return document;
    };
    const acceptConsent = async (kind, expectedRevision) => {
        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/settings/legal-consents/${kind}/accept`,
            headers: headers(),
            payload: {
                accepted: true,
                document: await legalDocument(kind),
                expectedRevision,
                idempotencyKey: randomUUID(),
            },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response;
    };
    const revokeConsent = async (kind, expectedRevision) => {
        const response = await app.inject({
            method: 'POST',
            url: `/api/v1/settings/legal-consents/${kind}/revoke`,
            headers: headers(),
            payload: { expectedRevision, idempotencyKey: randomUUID() },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response;
    };
    const acceptSpecialCategory = (expectedRevision) => acceptConsent('special_category', expectedRevision);
    const revokeSpecialCategory = (expectedRevision) => revokeConsent('special_category', expectedRevision);

    const secondLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: headers(),
        payload: { email, password: 'AcceptancePassword1!' },
    });
    assert.equal(secondLogin.statusCode, 200, secondLogin.body);
    for (const cookie of secondLogin.cookies) cookies.set(cookie.name, cookie.value);
    const secondUserSessionId = secondLogin.json().data.user.sessionId;
    assert.notEqual(secondUserSessionId, firstUserSessionId);
    const userSessions = await get('/api/v1/auth/sessions');
    assert.equal(userSessions.statusCode, 200, userSessions.body);
    assert.deepEqual(
        new Set(userSessions.json().data.sessions.map((session) => session.id)),
        new Set([firstUserSessionId, secondUserSessionId]),
    );
    assert.equal(
        userSessions.json().data.sessions.find((session) => session.id === secondUserSessionId)?.current,
        true,
    );
    const revokeOtherUserSessions = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke-others',
        headers: headers(),
        payload: {},
    });
    assert.equal(revokeOtherUserSessions.statusCode, 200, revokeOtherUserSessions.body);
    assert.equal(revokeOtherUserSessions.json().data.revokedCount, 1);
    const userSessionEffects = await pool.query(
        `select
           (select revoked_at is not null from meal.sessions where id=$1) first_revoked,
           (select revoked_at is null from meal.sessions where id=$2) current_active,
           (select count(*)::int from meal.audit_events where actor_id=$3 and action='auth.sessions.others_revoked' and target_id=$2) audits`,
        [firstUserSessionId, secondUserSessionId, userId],
    );
    assert.deepEqual(userSessionEffects.rows[0], { first_revoked: true, current_active: true, audits: 1 });

    const initialConsentState = await get('/api/v1/settings/legal-consents');
    assert.equal(initialConsentState.statusCode, 200, initialConsentState.body);
    assert.equal(initialConsentState.json().data.consents.length, 4);
    assert.equal(
        initialConsentState.json().data.consents.every((consent) => !consent.enabled),
        true,
    );
    const initialConsentHistory = await get('/api/v1/settings/legal-consents/history');
    assert.equal(initialConsentHistory.statusCode, 200, initialConsentHistory.body);
    assert.deepEqual(initialConsentHistory.json().data.events, []);

    const initialPrivacy = await get('/api/v1/settings/privacy');
    assert.equal(initialPrivacy.statusCode, 200, initialPrivacy.body);
    assert.equal(initialPrivacy.json().data.aiAccess.enabled, false);
    const privacyDisablePayload = {
        enabled: false,
        expectedVersion: initialPrivacy.json().data.version,
        consentVersion: null,
        accepted: false,
        idempotencyKey: randomUUID(),
    };
    const privacyDisable = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/privacy/ai-access',
        headers: headers(),
        payload: privacyDisablePayload,
    });
    assert.equal(privacyDisable.statusCode, 200, privacyDisable.body);
    assert.deepEqual(privacyDisable.json().data, initialPrivacy.json().data);

    const ownProfile = await get('/api/v1/profile');
    assert.equal(ownProfile.statusCode, 200, ownProfile.body);
    assert.equal(ownProfile.json().data.profile.id, userId);
    assert.equal(ownProfile.json().data.profile.email, email);
    const profileUpdatePayload = {
        displayName: 'PostgreSQL Acceptance Updated',
        timezone: 'Asia/Yekaterinburg',
        locale: 'ru',
        theme: 'system',
        expectedVersion: ownProfile.json().data.profile.version,
        idempotencyKey: randomUUID(),
    };
    const profileUpdate = await app.inject({
        method: 'PUT',
        url: '/api/v1/profile',
        headers: headers(),
        payload: profileUpdatePayload,
    });
    assert.equal(profileUpdate.statusCode, 200, profileUpdate.body);
    assert.equal(profileUpdate.json().data.profile.displayName, profileUpdatePayload.displayName);
    assert.equal(profileUpdate.json().data.profile.timezone, profileUpdatePayload.timezone);
    const profileReplay = await app.inject({
        method: 'PUT',
        url: '/api/v1/profile',
        headers: headers(),
        payload: profileUpdatePayload,
    });
    assert.equal(profileReplay.statusCode, 200, profileReplay.body);
    assert.deepEqual(profileReplay.json().data, profileUpdate.json().data);
    assert.equal((await get(`/api/v1/authors/accept_${suffix}`)).statusCode, 404);
    await acceptConsent('dissemination', 0);
    const publicProfile = await get(`/api/v1/authors/accept_${suffix}`);
    assert.equal(publicProfile.statusCode, 200, publicProfile.body);
    assert.deepEqual(Object.keys(publicProfile.json().data.profile).sort(), [
        'achievements',
        'avatarUrl',
        'recipeCount',
        'reputationLabel',
        'username',
    ]);
    assert.equal(publicProfile.json().data.profile.username, `accept_${suffix}`);

    const consentHistoryAfterProfile = await get('/api/v1/settings/legal-consents/history');
    assert.equal(consentHistoryAfterProfile.statusCode, 200, consentHistoryAfterProfile.body);
    assert.equal(consentHistoryAfterProfile.json().data.events.length, 1);
    assert.equal(consentHistoryAfterProfile.json().data.events[0].kind, 'dissemination');

    const frontTelemetry = await app.inject({
        method: 'POST',
        url: '/api/v1/telemetry/browser',
        headers: headers(),
        payload: { application: 'front', code: 'route_error', appVersion: '0.0.99' },
    });
    assert.equal(frontTelemetry.statusCode, 202, frontTelemetry.body);
    const adminCsrf = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
    assert.equal(adminCsrf.statusCode, 200, adminCsrf.body);
    const adminCsrfCookies = new Map(adminCsrf.cookies.map((cookie) => [cookie.name, cookie.value]));
    const adminTelemetry = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/telemetry/browser',
        headers: {
            origin: config.ADMIN_FRONTEND_ORIGIN,
            cookie: [...adminCsrfCookies].map(([name, value]) => `${name}=${value}`).join('; '),
            'x-csrf-token': adminCsrf.json().data.token,
        },
        payload: { application: 'admin', code: 'root_error', appVersion: '0.0.86' },
    });
    assert.equal(adminTelemetry.statusCode, 202, adminTelemetry.body);
    const coreDomainEffects = await pool.query(
        `select
           (select count(*)::int from meal.admin_error_events where code in ('browser.front.route_error','browser.admin.root_error')) telemetry_errors,
           (select count(*)::int from meal.admin_metric_events where event_name in ('browser.front.route_error.count','browser.admin.root_error.count')) telemetry_metrics,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$1 and operation='profile.update' and key=$2) profile_idempotency,
           (select count(*)::int from meal.legal_consent_events where user_id=$3 and kind='dissemination' and action='accepted') dissemination_accepts`,
        [`user:${userId}`, profileUpdatePayload.idempotencyKey, userId],
    );
    assert.deepEqual(coreDomainEffects.rows[0], {
        telemetry_errors: 2,
        telemetry_metrics: 2,
        profile_idempotency: 1,
        dissemination_accepts: 1,
    });
    console.log(
        `CORE_DOMAIN_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'core-domain-live-happy-path-v1',
            operationIds: [
                'AuthController_sessions',
                'AuthController_revokeOthers',
                'LegalConsentController_state',
                'LegalConsentController_history',
                'PrivacyController_state',
                'PrivacyController_update',
                'ProfilesController_own',
                'ProfilesController_update',
                'ProfilesController_public',
                'TelemetryController_browser',
                'TelemetryController_adminBrowser',
            ],
            effects: { ...userSessionEffects.rows[0], ...coreDomainEffects.rows[0] },
            assertions: {
                sessionIsolation: true,
                audit: true,
                consentGate: true,
                publicProjection: true,
                idempotentReplay: true,
                databaseEffects: true,
            },
        })}`,
    );

    const free = await entitlement('free', 'none');
    assert.equal(free.capabilities.family, false);
    assert.equal(free.capabilities.diary, false);
    assert.equal((await get('/api/v1/family')).json().data.state, 'none');
    assert.equal((await familyCreate('Недоступная семья')).statusCode, 403);
    assert.equal((await get('/api/v1/pro/overview')).statusCode, 403);
    assert.equal((await get('/api/v1/diary?date=2026-10-13')).statusCode, 403);
    assert.equal((await get('/api/v1/finance/overview?from=2026-10-01&to=2026-10-13')).statusCode, 403);

    const plusSubscription = await addSubscription('plus', 'trial');
    const plus = await entitlement('plus', 'trial');
    assert.equal(plus.capabilities.family, true);
    assert.equal(plus.capabilities.diary, false);
    const createdFamily = await familyCreate('Приёмочная семья');
    assert.equal(createdFamily.statusCode, 201, createdFamily.body);
    assert.equal(createdFamily.json().data.state, 'active');
    assert.equal(createdFamily.json().data.entitlement.plan, 'plus');
    assert.equal((await get('/api/v1/pro/overview')).statusCode, 403);

    const proSubscription = await addSubscription('pro', 'paid');
    const pro = await entitlement('pro', 'personal');
    assert.equal(pro.capabilities.diary, true);
    assert.equal(pro.capabilities.finance, true);
    const activeProOverview = await get('/api/v1/pro/overview');
    assert.equal(activeProOverview.statusCode, 200, activeProOverview.body);
    assert.equal(activeProOverview.json().data.access.mode, 'active');
    const blockedDiary = await get('/api/v1/diary?date=2026-10-13');
    assert.equal(blockedDiary.statusCode, 403, blockedDiary.body);
    assert.equal(blockedDiary.json().error.code, 'SPECIAL_CATEGORY_CONSENT_REQUIRED');
    await acceptSpecialCategory(0);
    const activeDiary = await get('/api/v1/diary?date=2026-10-13');
    assert.equal(activeDiary.statusCode, 200, activeDiary.body);
    assert.equal(activeDiary.json().data.access.mode, 'active');
    await revokeSpecialCategory(1);
    const revokedDiary = await get('/api/v1/diary?date=2026-10-13');
    assert.equal(revokedDiary.statusCode, 403, revokedDiary.body);
    assert.equal(revokedDiary.json().error.code, 'SPECIAL_CATEGORY_CONSENT_REQUIRED');
    await acceptSpecialCategory(2);
    assert.equal((await get('/api/v1/diary?date=2026-10-13')).statusCode, 200);
    const activeFinance = await get('/api/v1/finance/overview?from=2026-10-01&to=2026-10-13');
    assert.equal(activeFinance.statusCode, 200, activeFinance.body);
    assert.equal(activeFinance.json().data.access.mode, 'active');

    await expirePeriod(proSubscription.periodId);
    assert.equal((await entitlement('plus', 'trial')).capabilities.family, true);
    const formerProOverview = await get('/api/v1/pro/overview');
    assert.equal(formerProOverview.statusCode, 200, formerProOverview.body);
    assert.equal(formerProOverview.json().data.access.mode, 'read_only');
    assert.equal(formerProOverview.json().data.access.reason, 'pro_expired');

    await expirePeriod(plusSubscription.periodId);
    assert.equal((await entitlement('free', 'none')).capabilities.family, false);
    const blockedFamily = await get('/api/v1/family');
    assert.equal(blockedFamily.statusCode, 200, blockedFamily.body);
    assert.equal(blockedFamily.json().data.state, 'blocked');
    assert.equal(blockedFamily.json().data.blockedReason, 'coverage_required');
    const formerDiary = await get('/api/v1/diary?date=2026-10-13');
    assert.equal(formerDiary.statusCode, 200, formerDiary.body);
    assert.equal(formerDiary.json().data.access.mode, 'read_only');
    const formerFinance = await get('/api/v1/finance/overview?from=2026-10-01&to=2026-10-13');
    assert.equal(formerFinance.statusCode, 200, formerFinance.body);
    assert.equal(formerFinance.json().data.access.mode, 'read_only');

    const moderatorToken = randomBytes(32).toString('base64url');
    const moderatorSessionId = randomUUID();
    const moderatorRoleId = randomUUID();
    const moderatorTicketId = randomUUID();
    const financialTicketId = randomUUID();
    const moderationCaseId = randomUUID();
    const skippedCaseId = randomUUID();
    const competingCaseId = randomUUID();
    const rejectedCaseId = randomUUID();
    const publishedCaseId = randomUUID();
    const hiddenCaseId = randomUUID();
    const unpublishedCaseId = randomUUID();
    const secondModeratorId = randomUUID();
    const secondModeratorToken = randomBytes(32).toString('base64url');
    const secondModeratorSessionId = randomUUID();
    const secondModeratorRoleId = randomUUID();
    const recipeFixtures = [
        { recipeId: randomUUID(), revisionId: randomUUID(), caseId: publishedCaseId, status: 'approved' },
        { recipeId: randomUUID(), revisionId: randomUUID(), caseId: hiddenCaseId, status: 'published' },
        { recipeId: randomUUID(), revisionId: randomUUID(), caseId: unpublishedCaseId, status: 'published' },
    ];
    const privateScopeId = randomUUID();
    const moderatorGrants = new Map();
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(`insert into meal.data_scopes(id,kind,user_id,family_id) values($1,'private',$2,null)`, [
                privateScopeId,
                userId,
            ]);
            const assetIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
            for (const [index, assetId] of assetIds.entries())
                await client.query(
                    `insert into meal.media_assets(id,object_key,mime,size_bytes,checksum,status,alt_text,retention_class,uploader_id)
                     values($1,$2,'image/png',100,$3,'quarantined',$4,'moderation',$5)`,
                    [
                        assetId,
                        `acceptance/${suffix}/moderation-${index}.png`,
                        `sha256:${String(index + 1).repeat(64)}`,
                        `Приёмочный файл ${index + 1}`,
                        userId,
                    ],
                );
            for (const [index, fixture] of recipeFixtures.entries()) {
                await client.query(
                    `insert into meal.recipes(id,title,status,archived_at,author_id,scope_id)
                     values($1,$2,$3,null,$4,$5)`,
                    [fixture.recipeId, `Модерационный рецепт ${index + 1}`, fixture.status, userId, privateScopeId],
                );
                await client.query(
                    `insert into meal.recipe_revisions(id,revision,title,portions,method,nutrition_snapshot,timing,change_kind,recipe_id,created_by)
                     values($1,1,$2,2,'Приёмочный способ',null,null,'moderation',$3,$4)`,
                    [fixture.revisionId, `Модерационный рецепт ${index + 1}`, fixture.recipeId, userId],
                );
            }
            await client.query(
                `insert into meal.moderation_cases(id,kind,status,reason,submitted_at,queue_priority,evidence,asset_id)
                 values($1,'report','pending','Проверить материал',now()-interval '2 days',100,$2::jsonb,$3),
                       ($4,'report','pending','Можно пропустить уведомление',now(),0,$5::jsonb,$6)`,
                [
                    moderationCaseId,
                    JSON.stringify({
                        publicContent: 'Публичная версия',
                        originalContent: 'Исходная версия',
                        signals: ['acceptance'],
                    }),
                    assetIds[0],
                    skippedCaseId,
                    JSON.stringify({ publicContent: 'Второй материал', signals: [] }),
                    assetIds[1],
                ],
            );
            await client.query(
                `insert into meal.moderation_cases(id,kind,status,reason,submitted_at,queue_priority,evidence,asset_id,assigned_to)
                 values($1,'report','pending','Конкурентный захват',now(),50,$2::jsonb,$3,null),
                       ($4,'report','in_review','Отклонение материала',now(),25,$5::jsonb,$6,$7)`,
                [
                    competingCaseId,
                    JSON.stringify({ publicContent: 'Конкурентный материал', signals: ['race'] }),
                    assetIds[2],
                    rejectedCaseId,
                    JSON.stringify({ publicContent: 'Материал для отклонения', signals: ['reject'] }),
                    assetIds[3],
                    userId,
                ],
            );
            for (const fixture of recipeFixtures)
                await client.query(
                    `insert into meal.moderation_cases(id,kind,status,reason,submitted_at,queue_priority,evidence,recipe_revision_id,assigned_to)
                     values($1,'recipe',$2,'Проверка действия модератора',now(),10,$3::jsonb,$4,$5)`,
                    [
                        fixture.caseId,
                        fixture.status,
                        JSON.stringify({ publicContent: 'Публичная версия', signals: ['decision-action'] }),
                        fixture.revisionId,
                        userId,
                    ],
                );
            for (const caseId of [rejectedCaseId, publishedCaseId, hiddenCaseId, unpublishedCaseId])
                await client.query(
                    `insert into meal.moderation_claims(id,claimed_at,lease_until,released_at,outcome,case_id,staff_id)
                     values($1,now(),now()+interval '8 hours',null,null,$2,$3)`,
                    [randomUUID(), caseId, userId],
                );
            for (const fixture of recipeFixtures.filter((item) => item.status === 'published')) {
                const decisionId = randomUUID();
                await client.query(
                    `insert into meal.moderation_decisions(id,action,reason,decided_at,before_snapshot,after_snapshot,case_id,actor_id)
                     values($1,'publish','Приёмочная исходная публикация',now(),$2::jsonb,$3::jsonb,$4,$5)`,
                    [
                        decisionId,
                        JSON.stringify({ status: 'approved' }),
                        JSON.stringify({ status: 'published' }),
                        fixture.caseId,
                        userId,
                    ],
                );
                await client.query(
                    `insert into meal.recipe_publications(id,published_at,unpublished_at,revision_id,decision_id)
                     values($1,now()-interval '1 day',null,$2,$3)`,
                    [randomUUID(), fixture.revisionId, decisionId],
                );
            }
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.staff_role_assignments(id,role,assigned_at,user_id,assigned_by)
                 values($1,'moderator',now(),$2,$2)`,
                [moderatorRoleId, userId],
            );
            for (const permission of ['catalog.review', 'catalog.publish', 'support.reply']) {
                const grantId = randomUUID();
                moderatorGrants.set(permission, grantId);
                await client.query(
                    `insert into meal.staff_grants(id,permission,scope,valid_until,revoked_at,user_id,granted_by)
                     values($1,$2,'global',null,null,$3,$3)`,
                    [grantId, permission, userId],
                );
            }
            await client.query(
                `insert into meal.mfa_factors(id,kind,secret_ciphertext,verified_at,revoked_at,last_accepted_step,user_id)
                 values($1,'totp','acceptance-fixture',now(),null,null,$2)`,
                [randomUUID(), userId],
            );
            await client.query(
                `insert into meal.sessions(id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context)
                 values($1,'staff',$2,now()+interval '1 day',null,now(),now(),$3,'moderator')`,
                [moderatorSessionId, createHash('sha256').update(moderatorToken).digest('hex'), userId],
            );
            await client.query(
                `insert into meal.users(id,login,display_name,email_normalized,status,archived_at,email_verified_at,is_test_account)
                 values($1,$2,'Второй модератор',$3,'active',null,now(),true)`,
                [secondModeratorId, `moderator_${suffix}`, `moderator-${suffix}@example.test`],
            );
            await client.query(
                `insert into meal.staff_role_assignments(id,role,assigned_at,user_id,assigned_by)
                 values($1,'moderator',now(),$2,$2)`,
                [secondModeratorRoleId, secondModeratorId],
            );
            await client.query(
                `insert into meal.staff_grants(id,permission,scope,valid_until,revoked_at,user_id,granted_by)
                 values($1,'catalog.review','global',null,null,$2,$2)`,
                [randomUUID(), secondModeratorId],
            );
            await client.query(
                `insert into meal.mfa_factors(id,kind,secret_ciphertext,verified_at,revoked_at,last_accepted_step,user_id)
                 values($1,'totp','acceptance-second-moderator',now(),null,null,$2)`,
                [randomUUID(), secondModeratorId],
            );
            await client.query(
                `insert into meal.sessions(id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context)
                 values($1,'staff',$2,now()+interval '1 day',null,now(),now(),$3,'moderator')`,
                [
                    secondModeratorSessionId,
                    createHash('sha256').update(secondModeratorToken).digest('hex'),
                    secondModeratorId,
                ],
            );
            await client.query(
                `insert into meal.support_tickets(id,public_number,category,status,subject,requester_id,assignee_id,thread_id)
                 values($1,$2,'account','waiting_for_support','Приёмочный вопрос',$3,null,null),
                       ($4,$5,'billing','waiting_for_support','Финансовый вопрос',$3,null,null)`,
                [moderatorTicketId, `ACCEPT-${suffix}`, userId, financialTicketId, `FIN-${suffix}`],
            );
            await client.query(
                `insert into meal.support_messages(id,body,internal,ticket_id,author_id)
                 values($1,'Исходное обращение',false,$2,$3)`,
                [randomUUID(), moderatorTicketId, userId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const moderatorHeaders = () => ({
        ...headers(),
        cookie: `${headers().cookie}; meal_staff=${moderatorToken}`,
    });
    const secondModeratorHeaders = () => ({
        ...headers(),
        cookie: `${headers().cookie}; meal_staff=${secondModeratorToken}`,
    });
    const moderatorGet = (url) =>
        app.inject({
            method: 'GET',
            url,
            headers: moderatorHeaders(),
        });
    const moderatorOverview = await moderatorGet('/api/v1/moderator/overview');
    assert.equal(moderatorOverview.statusCode, 200, moderatorOverview.body);
    assert.deepEqual(
        moderatorOverview
            .json()
            .data.queues.map((queue) => queue.key)
            .sort(),
        ['authorship', 'products', 'recipe_variants', 'recipes', 'reports', 'support'],
    );
    for (const queue of ['recipes', 'recipe_variants', 'products', 'reports', 'support', 'authorship']) {
        const response = await moderatorGet(`/api/v1/moderator/queues/${queue}`);
        assert.equal(response.statusCode, 200, `${queue}: ${response.body}`);
        assert.equal(response.json().data.queue, queue);
        assert.equal(
            response.json().data.items.length,
            queue === 'support' ? 1 : queue === 'reports' ? 4 : queue === 'recipes' ? 3 : 0,
        );
    }
    const unknownQueue = await moderatorGet('/api/v1/moderator/queues/not-a-queue');
    assert.equal(unknownQueue.statusCode, 400, unknownQueue.body);
    assert.equal(errorEnvelopeSchema.safeParse(unknownQueue.json()).success, true);
    const moderatorPost = (url, payload) => app.inject({ method: 'POST', url, headers: moderatorHeaders(), payload });
    const secondModeratorPost = (url, payload) =>
        app.inject({ method: 'POST', url, headers: secondModeratorHeaders(), payload });
    const moderationItem = await moderatorGet(`/api/v1/moderator/items/${moderationCaseId}`);
    assert.equal(moderationItem.statusCode, 200, moderationItem.body);
    assert.equal(moderationItem.json().data.version, 1);
    assert.equal(moderationItem.json().data.assignment, 'unassigned');
    assert.equal(
        (
            await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/claim`, {
                version: 2,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        409,
    );
    const claimPayload = { version: 1, idempotencyKey: randomUUID() };
    const claimed = await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/claim`, claimPayload);
    assert.equal(claimed.statusCode, 200, claimed.body);
    assert.equal(claimed.json().data.version, 2);
    assert.equal(claimed.json().data.status, 'in_review');
    assert.equal(claimed.json().data.assignment, 'mine');
    const claimReplay = await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/claim`, claimPayload);
    assert.equal(claimReplay.statusCode, 200, claimReplay.body);
    assert.equal(claimReplay.json().data.version, 2);
    assert.equal(
        (
            await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/claim`, {
                ...claimPayload,
                version: 2,
            })
        ).statusCode,
        409,
    );
    const decisionPayload = {
        action: 'approve',
        category: 'quality',
        reason: 'Проверено вручную',
        version: 2,
        idempotencyKey: randomUUID(),
    };
    const decided = await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/decision`, decisionPayload);
    assert.equal(decided.statusCode, 200, decided.body);
    assert.equal(decided.json().data.version, 3);
    assert.equal(decided.json().data.status, 'approved');
    const decisionReplay = await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/decision`, decisionPayload);
    assert.equal(decisionReplay.statusCode, 200, decisionReplay.body);
    assert.equal(decisionReplay.json().data.version, 3);
    assert.equal(
        (
            await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/decision`, {
                ...decisionPayload,
                reason: 'Другой результат',
            })
        ).statusCode,
        409,
    );
    const unavailableRepeat = await moderatorPost(`/api/v1/moderator/items/${moderationCaseId}/decision`, {
        ...decisionPayload,
        version: 3,
        idempotencyKey: randomUUID(),
        reason: 'Повторное одобрение после перехода',
    });
    assert.equal(unavailableRepeat.statusCode, 409, unavailableRepeat.body);
    const skipPayload = { version: 1, idempotencyKey: randomUUID() };
    const skipped = await moderatorPost(`/api/v1/moderator/items/${skippedCaseId}/skip`, skipPayload);
    assert.equal(skipped.statusCode, 200, skipped.body);
    assert.equal(skipped.json().data.version, 1);
    assert.equal(skipped.json().data.status, 'pending');
    assert.equal(skipped.json().data.assignment, 'unassigned');
    const skipReplay = await moderatorPost(`/api/v1/moderator/items/${skippedCaseId}/skip`, skipPayload);
    assert.equal(skipReplay.statusCode, 200, skipReplay.body);
    assert.equal(skipReplay.json().data.version, 1);
    const moderationEffects = await pool.query(
        `select
           (select count(*)::int from meal.moderation_claims where case_id=$1) case_claims,
           (select count(*)::int from meal.moderation_decisions where case_id=$1) case_decisions,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and target_binding=$1::text) case_idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$4 and target_id=$1) case_audits,
           (select bool_and(released_at is not null and outcome='approve') from meal.moderation_claims where case_id=$1) claim_released,
           (select count(*)::int from meal.moderation_claims where case_id=$2 and outcome='notification_skipped') skip_claims,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and target_binding=$2::text) skip_idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$4 and target_id=$2) skip_audits`,
        [moderationCaseId, skippedCaseId, `moderator:${userId}`, userId],
    );
    assert.deepEqual(moderationEffects.rows[0], {
        case_claims: 1,
        case_decisions: 1,
        case_idempotency: 2,
        case_audits: 2,
        claim_released: true,
        skip_claims: 1,
        skip_idempotency: 1,
        skip_audits: 1,
    });
    const competingPayloads = [
        { version: 1, idempotencyKey: randomUUID() },
        { version: 1, idempotencyKey: randomUUID() },
    ];
    const competingClaims = await Promise.all([
        moderatorPost(`/api/v1/moderator/items/${competingCaseId}/claim`, competingPayloads[0]),
        secondModeratorPost(`/api/v1/moderator/items/${competingCaseId}/claim`, competingPayloads[1]),
    ]);
    assert.deepEqual(
        competingClaims.map((response) => response.statusCode).sort((left, right) => left - right),
        [200, 409],
    );
    const competingState = await pool.query(
        `select mc.version::int,mc.status,mc.assigned_to,
           (select count(*)::int from meal.moderation_claims c where c.case_id=mc.id) claims,
           (select count(*)::int from meal.idempotency_records i where i.target_binding=mc.id::text) idempotency,
           (select count(*)::int from meal.audit_events a where a.target_id=mc.id) audits
         from meal.moderation_cases mc where mc.id=$1`,
        [competingCaseId],
    );
    assert.equal(competingState.rows.length, 1);
    assert.equal(competingState.rows[0].version, 2);
    assert.equal(competingState.rows[0].status, 'in_review');
    assert.equal([userId, secondModeratorId].includes(competingState.rows[0].assigned_to), true);
    assert.equal(competingState.rows[0].claims, 1);
    assert.equal(competingState.rows[0].idempotency, 1);
    assert.equal(competingState.rows[0].audits, 1);

    const decisionCases = [
        { id: rejectedCaseId, action: 'reject', status: 'rejected' },
        { id: publishedCaseId, action: 'publish', status: 'published' },
        { id: hiddenCaseId, action: 'hide', status: 'hide' },
        { id: unpublishedCaseId, action: 'unpublish', status: 'unpublish' },
    ];
    for (const decisionCase of decisionCases) {
        const payload = {
            action: decisionCase.action,
            category: 'acceptance',
            reason: `Проверено действие ${decisionCase.action}`,
            version: 1,
            idempotencyKey: randomUUID(),
        };
        const response = await moderatorPost(`/api/v1/moderator/items/${decisionCase.id}/decision`, payload);
        assert.equal(response.statusCode, 200, `${decisionCase.action}: ${response.body}`);
        assert.equal(response.json().data.version, 2);
        assert.equal(response.json().data.status, decisionCase.status);
        const replay = await moderatorPost(`/api/v1/moderator/items/${decisionCase.id}/decision`, payload);
        assert.equal(replay.statusCode, 200, `${decisionCase.action} replay: ${replay.body}`);
        assert.equal(replay.json().data.version, 2);
        const changedReplay = await moderatorPost(`/api/v1/moderator/items/${decisionCase.id}/decision`, {
            ...payload,
            reason: `${payload.reason} — изменено`,
        });
        assert.equal(changedReplay.statusCode, 409, `${decisionCase.action} changed replay: ${changedReplay.body}`);
    }
    const actionEffects = await pool.query(
        `select
           (select count(*)::int from meal.moderation_decisions where case_id=$1 and action='reject') rejected,
           (select count(*)::int from meal.moderation_decisions where case_id=$2 and action='publish') published,
           (select count(*)::int from meal.moderation_decisions where case_id=$3 and action='hide') hidden,
           (select count(*)::int from meal.moderation_decisions where case_id=$4 and action='unpublish') unpublished,
           (select count(*)::int from meal.recipe_publications where revision_id=$5 and unpublished_at is null) publish_active,
           (select count(*)::int from meal.recipe_publications where revision_id=$6 and unpublished_at is not null) hide_closed,
           (select count(*)::int from meal.recipe_publications where revision_id=$7 and unpublished_at is not null) unpublish_closed,
           (select count(*)::int from meal.moderation_claims where case_id=any($8::uuid[]) and released_at is not null) released_claims,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$9 and target_binding=any($10::text[])) idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$11 and target_id=any($8::uuid[])) audits`,
        [
            rejectedCaseId,
            publishedCaseId,
            hiddenCaseId,
            unpublishedCaseId,
            recipeFixtures[0].revisionId,
            recipeFixtures[1].revisionId,
            recipeFixtures[2].revisionId,
            decisionCases.map((item) => item.id),
            `moderator:${userId}`,
            decisionCases.map((item) => item.id),
            userId,
        ],
    );
    assert.deepEqual(actionEffects.rows[0], {
        rejected: 1,
        published: 1,
        hidden: 1,
        unpublished: 1,
        publish_active: 1,
        hide_closed: 1,
        unpublish_closed: 1,
        released_claims: 4,
        idempotency: 4,
        audits: 4,
    });
    const supportDetail = await moderatorGet(`/api/v1/moderator/support/${moderatorTicketId}`);
    assert.equal(supportDetail.statusCode, 200, supportDetail.body);
    assert.equal(supportDetail.json().data.version, 1);
    assert.equal(supportDetail.json().data.canReply, true);
    assert.equal((await moderatorGet(`/api/v1/moderator/support/${financialTicketId}`)).statusCode, 403);
    const replyKey = randomUUID();
    const replyPayload = { message: 'Ответ поддержки', version: 1, idempotencyKey: replyKey };
    const reply = await app.inject({
        method: 'POST',
        url: `/api/v1/moderator/support/${moderatorTicketId}/reply`,
        headers: moderatorHeaders(),
        payload: replyPayload,
    });
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(reply.json().data.version, 2);
    assert.equal(reply.json().data.status, 'waiting_for_user');
    assert.equal(reply.json().data.assignment, 'mine');
    assert.equal(reply.json().data.messages.length, 2);
    const replyReplay = await app.inject({
        method: 'POST',
        url: `/api/v1/moderator/support/${moderatorTicketId}/reply`,
        headers: moderatorHeaders(),
        payload: replyPayload,
    });
    assert.equal(replyReplay.statusCode, 200, replyReplay.body);
    assert.equal(replyReplay.json().data.messages.length, 2);
    const changedReplay = await app.inject({
        method: 'POST',
        url: `/api/v1/moderator/support/${moderatorTicketId}/reply`,
        headers: moderatorHeaders(),
        payload: { ...replyPayload, message: 'Изменённый ответ' },
    });
    assert.equal(changedReplay.statusCode, 409, changedReplay.body);

    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `update meal.support_tickets
                 set status='closed',closed_at=now(),version=version+1 where id=$1`,
                [moderatorTicketId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const closedSupport = await moderatorGet(`/api/v1/moderator/support/${moderatorTicketId}`);
    assert.equal(closedSupport.statusCode, 200, closedSupport.body);
    assert.equal(closedSupport.json().data.version, 3);
    assert.equal(closedSupport.json().data.canReopen, true);
    const reopenPayload = { version: 3, idempotencyKey: randomUUID() };
    const reopened = await app.inject({
        method: 'POST',
        url: `/api/v1/moderator/support/${moderatorTicketId}/reopen`,
        headers: moderatorHeaders(),
        payload: reopenPayload,
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().data.version, 4);
    assert.equal(reopened.json().data.status, 'waiting_for_support');
    const reopenReplay = await app.inject({
        method: 'POST',
        url: `/api/v1/moderator/support/${moderatorTicketId}/reopen`,
        headers: moderatorHeaders(),
        payload: reopenPayload,
    });
    assert.equal(reopenReplay.statusCode, 200, reopenReplay.body);
    assert.equal(reopenReplay.json().data.version, 4);
    const moderatorEffects = await pool.query(
        `select
           (select count(*)::int from meal.support_messages where ticket_id=$1) messages,
           (select count(*)::int from meal.support_events where ticket_id=$1) events,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and target_binding=$1::text) idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$3 and target_id=$1) audits`,
        [moderatorTicketId, `moderator:${userId}`, userId],
    );
    assert.deepEqual(moderatorEffects.rows[0], { messages: 2, events: 2, idempotency: 2, audits: 2 });

    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query('update meal.staff_grants set revoked_at=now() where id=$1', [
                moderatorGrants.get('support.reply'),
            ]);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    assert.equal((await moderatorGet('/api/v1/moderator/queues/support')).statusCode, 403);
    const restrictedOverview = await moderatorGet('/api/v1/moderator/overview');
    assert.equal(restrictedOverview.statusCode, 200, restrictedOverview.body);
    const restrictedSupport = restrictedOverview.json().data.queues.find((queue) => queue.key === 'support');
    assert.equal(restrictedSupport.available, false);
    assert.equal(restrictedSupport.count, null);

    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                'update meal.staff_role_assignments set revoked_at=now(),version=version+1 where id=$1',
                [moderatorRoleId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    assert.equal((await moderatorGet('/api/v1/moderator/overview')).statusCode, 401);

    const adminToken = randomBytes(32).toString('base64url');
    const adminUnlock = randomBytes(32).toString('base64url');
    const adminSessionId = randomUUID();
    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.staff_role_assignments(id,role,assigned_at,user_id,assigned_by)
                 values($1,'admin',now(),$2,$2)`,
                [randomUUID(), userId],
            );
            await client.query(
                `insert into meal.sessions(id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context)
                 values($1,'staff',$2,now()+interval '1 day',null,now(),now(),$3,'admin')`,
                [adminSessionId, createHash('sha256').update(adminToken).digest('hex'), userId],
            );
            await client.query(
                `insert into meal.admin_session_unlocks(id,session_id,token_hash,expires_at)
                 values($1,$2,$3,now()+interval '1 day')`,
                [randomUUID(), adminSessionId, createHash('sha256').update(adminUnlock).digest('hex')],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const adminHeaders = (unlock = adminUnlock) => ({
        cookie: `meal_admin=${adminToken}`,
        'x-admin-unlock': unlock,
    });
    assert.equal(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: adminHeaders('invalid') }))
            .statusCode,
        403,
    );
    assert.equal(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: adminHeaders() })).statusCode,
        200,
    );

    const largeTenantRows = 10_000;
    const largeTenantUnitId = randomUUID();
    const nutritionUnitId = randomUUID();
    const largeTenantCategoryId = randomUUID();
    const largeTenantIngredientId = randomUUID();
    const activeFinanceIngredientId = randomUUID();
    const searchStoreId = randomUUID();
    const seedStarted = performance.now();
    const fixtureClient = await ownerPool.connect();
    try {
        await fixtureClient.query('begin isolation level serializable');
        await fixtureClient.query(
            `insert into meal.units(id,code,dimension,factor,approximate)
             values($1,$2,'count',1,false),($3,'g','mass',1,false)`,
            [largeTenantUnitId, 'pcs', nutritionUnitId],
        );
        await fixtureClient.query(`insert into meal.categories(id,code,name,parent_id) values($1,$2,$3,null)`, [
            largeTenantCategoryId,
            `acceptance-${suffix}`,
            'Acceptance category',
        ]);
        await fixtureClient.query(
            `insert into meal.ingredients(
               id,name,aliases,status,default_storage_type,primary_category_id,default_unit_id
             ) values($1,$2,'[]'::jsonb,'published','pantry',$3,$4)`,
            [largeTenantIngredientId, `Acceptance ingredient ${suffix}`, largeTenantCategoryId, largeTenantUnitId],
        );
        await fixtureClient.query(
            `insert into meal.ingredients(
               id,name,aliases,status,default_storage_type,primary_category_id,default_unit_id
             ) values($1,$2,'[]'::jsonb,'active','pantry',$3,$4)`,
            [activeFinanceIngredientId, `Finance ingredient ${suffix}`, largeTenantCategoryId, nutritionUnitId],
        );
        await fixtureClient.query(`insert into meal.stores(id,name,external_ref) values($1,$2,null)`, [
            searchStoreId,
            `Acceptance store ${suffix}`,
        ]);
        await fixtureClient.query(
            `insert into meal.inventory_batches(
               id,kind,name,quantity,quantity_known,precision,package_state,
               purchased_on,expiry_on,scope_id,unit_id,ingredient_id,created_by,created_at,metadata
             )
             select gen_random_uuid(),'ingredient','Large tenant item '||series.value,
               1,true,'exact','sealed',current_date-(series.value % 30),
               current_date+((series.value % 60)-20),$1,$2,$3,$4,
               now()-(series.value * interval '1 millisecond'),'{"quantitySource":"user"}'::jsonb
             from generate_series(1,$5::integer) as series(value)`,
            [privateScopeId, largeTenantUnitId, largeTenantIngredientId, userId, largeTenantRows],
        );
        await fixtureClient.query('commit');
    } catch (error) {
        await fixtureClient.query('rollback');
        throw error;
    } finally {
        fixtureClient.release();
    }

    const catalogRequest = (method, url, payload) =>
        app.inject({
            method,
            url,
            headers: method === 'GET' ? { cookie: headers().cookie } : headers(),
            ...(payload === undefined ? {} : { payload }),
        });
    const referencesResponse = await catalogRequest('GET', '/api/v1/products/reference');
    assert.equal(referencesResponse.statusCode, 200, referencesResponse.body);
    assert.equal(
        referencesResponse.json().data.categories.some((category) => category.id === largeTenantCategoryId),
        true,
    );
    const proposalKey = randomUUID();
    const proposedName = `Acceptance product ${suffix}`;
    const proposedBrand = `Acceptance brand ${suffix}`;
    const proposalPayload = {
        idempotencyKey: proposalKey,
        name: proposedName,
        categoryId: largeTenantCategoryId,
        unit: 'pcs',
        brand: proposedBrand,
        packageQuantity: '500',
        barcode: null,
        compositionText: 'Acceptance composition',
        kcal: '123',
        protein: '4.5',
        fat: '6.7',
        carbs: '18.2',
        nutritionBasisUnit: 'g',
        allergens: [],
        source: 'user',
        sourceText: null,
    };
    const proposalResponse = await catalogRequest('POST', '/api/v1/products/proposals', proposalPayload);
    assert.equal(proposalResponse.statusCode, 200, proposalResponse.body);
    const proposedProduct = proposalResponse.json().data.product;
    assert.equal(proposedProduct.name, proposedName);
    assert.equal(proposedProduct.status, 'pending');
    assert.equal(proposedProduct.owned, true);
    assert.equal(proposedProduct.provenance, 'Предложено вами; ожидает модерации');
    assert.equal(proposedProduct.variants[0].products[0].brand, proposedBrand);
    assert.equal(Number(proposedProduct.variants[0].products[0].nutrition.kcal), 123);
    const proposalReplay = await catalogRequest('POST', '/api/v1/products/proposals', proposalPayload);
    assert.equal(proposalReplay.statusCode, 200, proposalReplay.body);
    assert.equal(proposalReplay.json().data.product.id, proposedProduct.id);
    assert.equal(
        (
            await catalogRequest('POST', '/api/v1/products/proposals', {
                ...proposalPayload,
                name: `${proposedName} changed`,
            })
        ).statusCode,
        409,
    );
    const proposedList = await catalogRequest('GET', `/api/v1/products?q=${encodeURIComponent(proposedName)}`);
    assert.equal(proposedList.statusCode, 200, proposedList.body);
    assert.deepEqual(
        proposedList.json().data.items.map((item) => item.id),
        [proposedProduct.id],
    );
    const proposedDetail = await catalogRequest('GET', `/api/v1/products/${proposedProduct.id}`);
    assert.equal(proposedDetail.statusCode, 200, proposedDetail.body);
    assert.equal(proposedDetail.json().data.product.proposalId, proposedProduct.proposalId);
    const proposalEffects = await pool.query(
        `select
           (select count(*)::int from meal.ingredients where id=$1) ingredients,
           (select count(*)::int from meal.ingredient_variants where ingredient_id=$1) variants,
           (select count(*)::int from meal.brand_products bp join meal.ingredient_variants iv on iv.id=bp.variant_id where iv.ingredient_id=$1) products,
           (select count(*)::int from meal.composition_versions cv join meal.brand_products bp on bp.id=cv.product_id join meal.ingredient_variants iv on iv.id=bp.variant_id where iv.ingredient_id=$1) compositions,
           (select count(*)::int from meal.catalog_proposals where id=$2) proposals,
           (select count(*)::int from meal.catalog_proposal_revisions where proposal_id=$2) revisions,
           (select count(*)::int from meal.moderation_cases mc join meal.catalog_proposal_revisions cpr on cpr.id=mc.catalog_proposal_revision_id where cpr.proposal_id=$2) cases,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and operation='catalog.propose' and key=$4) idempotency`,
        [proposedProduct.id, proposedProduct.proposalId, `user:${userId}`, proposalKey],
    );
    assert.deepEqual(proposalEffects.rows[0], {
        ingredients: 1,
        variants: 1,
        products: 1,
        compositions: 1,
        proposals: 1,
        revisions: 1,
        cases: 1,
        idempotency: 1,
    });

    const publicRecipe = recipeFixtures[0];
    const recipeQuery = encodeURIComponent('Модерационный рецепт 1');
    const recipesResponse = await catalogRequest('GET', `/api/v1/recipes?tab=new&scope=private&q=${recipeQuery}`);
    assert.equal(recipesResponse.statusCode, 200, recipesResponse.body);
    assert.deepEqual(
        recipesResponse.json().data.items.map((item) => item.id),
        [publicRecipe.recipeId],
    );
    const recipeDetail = await catalogRequest('GET', `/api/v1/recipes/${publicRecipe.recipeId}`);
    assert.equal(recipeDetail.statusCode, 200, recipeDetail.body);
    assert.equal(recipeDetail.json().data.recipe.revisionId, publicRecipe.revisionId);
    assert.equal(recipeDetail.json().data.recipe.method, 'Приёмочный способ');
    const recipePersonal = await catalogRequest('GET', `/api/v1/recipes/${publicRecipe.recipeId}/personal?servings=3`);
    assert.equal(recipePersonal.statusCode, 200, recipePersonal.body);
    assert.equal(recipePersonal.json().data.servings, 3);
    assert.equal(recipePersonal.json().data.bookmarked, false);
    const bookmarkKey = randomUUID();
    const bookmarkPayload = { bookmarked: true, idempotencyKey: bookmarkKey };
    const bookmark = await catalogRequest('POST', `/api/v1/recipes/${publicRecipe.recipeId}/bookmark`, bookmarkPayload);
    assert.equal(bookmark.statusCode, 200, bookmark.body);
    assert.equal(bookmark.json().data.bookmarked, true);
    const bookmarkReplay = await catalogRequest(
        'POST',
        `/api/v1/recipes/${publicRecipe.recipeId}/bookmark`,
        bookmarkPayload,
    );
    assert.equal(bookmarkReplay.statusCode, 200, bookmarkReplay.body);
    assert.equal(
        (
            await catalogRequest('POST', `/api/v1/recipes/${publicRecipe.recipeId}/bookmark`, {
                bookmarked: false,
                idempotencyKey: bookmarkKey,
            })
        ).statusCode,
        409,
    );
    assert.equal(
        (await catalogRequest('GET', `/api/v1/recipes/${publicRecipe.recipeId}/personal?servings=3`)).json().data
            .bookmarked,
        true,
    );
    const removeBookmark = await catalogRequest('POST', `/api/v1/recipes/${publicRecipe.recipeId}/bookmark`, {
        bookmarked: false,
        idempotencyKey: randomUUID(),
    });
    assert.equal(removeBookmark.statusCode, 200, removeBookmark.body);
    const restoreBookmark = await catalogRequest('POST', `/api/v1/recipes/${publicRecipe.recipeId}/bookmark`, {
        bookmarked: true,
        idempotencyKey: randomUUID(),
    });
    assert.equal(restoreBookmark.statusCode, 200, restoreBookmark.body);
    const bookmarkEffects = await pool.query(
        `select count(*)::int rows,max(version)::int version,
                count(*) filter(where removed_at is null)::int active
         from meal.recipe_bookmarks where user_id=$1 and recipe_id=$2`,
        [userId, publicRecipe.recipeId],
    );
    assert.deepEqual(bookmarkEffects.rows[0], { rows: 1, version: 3, active: 1 });

    for (const searchCase of [
        { type: 'product', q: proposedName, id: proposedProduct.id },
        { type: 'recipe', q: 'Модерационный рецепт 1', id: publicRecipe.recipeId },
        { type: 'brand', q: proposedBrand, id: proposedProduct.variants[0].products[0].id },
        { type: 'store', q: `Acceptance store ${suffix}`, id: searchStoreId },
    ]) {
        const response = await catalogRequest(
            'GET',
            `/api/v1/search?type=${searchCase.type}&q=${encodeURIComponent(searchCase.q)}`,
        );
        assert.equal(response.statusCode, 200, `${searchCase.type}: ${response.body}`);
        assert.equal(response.json().data.type, searchCase.type);
        assert.equal(response.json().data.items.length, 1);
        if (searchCase.type === 'brand') assert.equal(response.json().data.items[0].name, proposedBrand);
        else assert.equal(response.json().data.items[0].id, searchCase.id);
    }
    console.log(
        `CATALOG_RECIPE_SEARCH_EVIDENCE ${JSON.stringify({
            schema: 'catalog-recipe-search-live-happy-path-v1',
            operationIds: [
                'ProductsController_references',
                'ProductsController_propose',
                'ProductsController_list',
                'ProductsController_detail',
                'RecipesController_list',
                'RecipesController_detail',
                'RecipesController_personal',
                'RecipesController_bookmark',
                'SearchController_list',
            ],
            effects: { ...proposalEffects.rows[0], bookmarks: bookmarkEffects.rows[0] },
            assertions: {
                ownedPendingVisibility: true,
                proposalReplay: true,
                bookmarkDesiredState: true,
                publicProjection: true,
                searchDiscriminators: true,
                databaseEffects: true,
            },
        })}`,
    );

    const communityAttemptId = randomUUID();
    const communityCommentIds = [randomUUID(), randomUUID(), randomUUID()];
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.cooking_attempts(
                   id,status,started_at,completed_at,recipe_snapshot,output_snapshot,
                   confirmed_duration,private_note,scope_id,actor_id,revision_id
                 ) values($1,'completed',now()-interval '2 hours',now()-interval '1 hour',$2::jsonb,'{}'::jsonb,30,null,$3,$4,$5)`,
                [
                    communityAttemptId,
                    JSON.stringify({
                        recipeId: publicRecipe.recipeId,
                        revisionId: publicRecipe.revisionId,
                        title: 'Модерационный рецепт 1',
                        servings: 2,
                        method: 'Приёмочный способ',
                        steps: [],
                    }),
                    privateScopeId,
                    userId,
                    publicRecipe.revisionId,
                ],
            );
            await client.query(
                `insert into meal.recipe_comments(
                   id,body,edited_at,removed_at,recipe_id,author_id,attempt_id,reply_to_id,created_at
                 ) values
                   ($1,'Первый публичный комментарий',null,null,$4,$5,$6,null,now()-interval '30 minutes'),
                   ($2,'Ответ на публичный комментарий',now()-interval '10 minutes',null,$4,$5,$6,$1,now()-interval '20 minutes'),
                   ($3,'Удалённый комментарий',null,now()-interval '5 minutes',$4,$5,$6,null,now()-interval '10 minutes')`,
                [
                    communityCommentIds[0],
                    communityCommentIds[1],
                    communityCommentIds[2],
                    publicRecipe.recipeId,
                    userId,
                    communityAttemptId,
                ],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const communityQuery = encodeURIComponent('Модерационный рецепт 1');
    const communityAuthor = encodeURIComponent(`accept_${suffix}`);
    const communityRequest = (url) => app.inject({ method: 'GET', url, remoteAddress: '198.51.100.42' });
    const communityFeed = await communityRequest(
        `/api/v1/community?q=${communityQuery}&author=${communityAuthor}&sort=oldest&limit=1`,
    );
    assert.equal(communityFeed.statusCode, 200, communityFeed.body);
    assert.deepEqual(
        communityFeed.json().data.items.map((item) => item.id),
        [publicRecipe.recipeId],
    );
    assert.equal(communityFeed.json().data.items[0].authorLogin, `accept_${suffix}`);
    assert.equal(communityFeed.json().data.nextCursor, null);
    assert.equal(
        (await communityRequest(`/api/v1/community?q=${encodeURIComponent('missing public recipe')}`)).json().data.items
            .length,
        0,
    );
    assert.equal((await communityRequest('/api/v1/community?cursor=invalid')).statusCode, 400);

    const firstCommentsPage = await communityRequest(
        `/api/v1/community/recipes/${publicRecipe.recipeId}/comments?limit=1`,
    );
    assert.equal(firstCommentsPage.statusCode, 200, firstCommentsPage.body);
    assert.deepEqual(
        firstCommentsPage.json().data.items.map((item) => item.id),
        [communityCommentIds[0]],
    );
    assert.ok(firstCommentsPage.json().data.nextCursor);
    const secondCommentsPage = await communityRequest(
        `/api/v1/community/recipes/${publicRecipe.recipeId}/comments?limit=1&cursor=${encodeURIComponent(firstCommentsPage.json().data.nextCursor)}`,
    );
    assert.equal(secondCommentsPage.statusCode, 200, secondCommentsPage.body);
    assert.deepEqual(
        secondCommentsPage.json().data.items.map((item) => item.id),
        [communityCommentIds[1]],
    );
    assert.equal(secondCommentsPage.json().data.items[0].edited, true);
    assert.equal(secondCommentsPage.json().data.items[0].replyToId, communityCommentIds[0]);
    assert.equal(secondCommentsPage.json().data.nextCursor, null);
    assert.equal((await communityRequest(`/api/v1/community/recipes/${randomUUID()}/comments`)).statusCode, 404);
    assert.equal(
        (await communityRequest(`/api/v1/community/recipes/${publicRecipe.recipeId}/comments?cursor=invalid`))
            .statusCode,
        400,
    );
    const communityEffects = await pool.query(
        `select count(*)::int total,
                count(*) filter(where removed_at is null)::int visible,
                count(*) filter(where edited_at is not null)::int edited,
                count(*) filter(where reply_to_id is not null)::int replies
         from meal.recipe_comments where recipe_id=$1`,
        [publicRecipe.recipeId],
    );
    assert.deepEqual(communityEffects.rows[0], { total: 3, visible: 2, edited: 1, replies: 1 });
    console.log(
        `COMMUNITY_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'community-live-happy-path-v1',
            operationIds: ['CommunityController_feed', 'CommunityController_comments'],
            effects: communityEffects.rows[0],
            assertions: {
                publicProjection: true,
                queryAndAuthorFilters: true,
                commentCursorPagination: true,
                removedCommentHidden: true,
                invalidCursorRejected: true,
                unpublishedRecipeRejected: true,
            },
        })}`,
    );

    const supportMeta = await catalogRequest('GET', '/api/v1/support/meta');
    assert.equal(supportMeta.statusCode, 200, supportMeta.body);
    assert.equal(supportMeta.json().data.uploadMode, 'unavailable');
    const supportKey = randomUUID();
    const supportCreatePayload = {
        category: 'general',
        subject: `Acceptance support ${suffix}`,
        body: 'Первое сообщение пользователя',
        attachments: [],
        idempotencyKey: supportKey,
    };
    const supportCreate = await catalogRequest('POST', '/api/v1/support', supportCreatePayload);
    assert.equal(supportCreate.statusCode, 200, supportCreate.body);
    const supportTicket = supportCreate.json().data;
    assert.equal(supportTicket.ticket.version, 1);
    assert.equal(supportTicket.messages.length, 1);
    const supportMessageId = supportTicket.messages[0].id;
    const supportCreateReplay = await catalogRequest('POST', '/api/v1/support', supportCreatePayload);
    assert.equal(supportCreateReplay.statusCode, 200, supportCreateReplay.body);
    assert.equal(supportCreateReplay.json().data.ticket.id, supportTicket.ticket.id);
    assert.equal(
        (
            await catalogRequest('POST', '/api/v1/support', {
                ...supportCreatePayload,
                subject: `${supportCreatePayload.subject} changed`,
            })
        ).statusCode,
        409,
    );
    const blockedAttachment = await catalogRequest('POST', '/api/v1/support', {
        ...supportCreatePayload,
        idempotencyKey: randomUUID(),
        attachments: [{ name: 'evidence.png', mime: 'image/png', size: 10, duration: null }],
    });
    assert.equal(blockedAttachment.statusCode, 409, blockedAttachment.body);
    const supportList = await catalogRequest('GET', `/api/v1/support?category=general&status=active&limit=20&offset=0`);
    assert.equal(supportList.statusCode, 200, supportList.body);
    assert.equal(
        supportList.json().data.items.some((ticket) => ticket.id === supportTicket.ticket.id),
        true,
    );
    const userSupportDetail = await catalogRequest('GET', `/api/v1/support/${supportTicket.ticket.id}`);
    assert.equal(userSupportDetail.statusCode, 200, userSupportDetail.body);
    assert.equal(userSupportDetail.json().data.messages[0].own, true);
    const foreignTicketId = randomUUID();
    const foreignSupportClient = await ownerPool.connect();
    try {
        await foreignSupportClient.query('begin isolation level serializable');
        await foreignSupportClient.query(
            `insert into meal.support_tickets(id,public_number,category,status,subject,requester_id,assignee_id,thread_id)
             values($1,$2,'general','open','Чужое обращение',$3,null,null)`,
            [foreignTicketId, `FOREIGN-${suffix}`, secondModeratorId],
        );
        await foreignSupportClient.query('commit');
    } catch (error) {
        await foreignSupportClient.query('rollback');
        throw error;
    } finally {
        foreignSupportClient.release();
    }
    assert.equal((await catalogRequest('GET', `/api/v1/support/${foreignTicketId}`)).statusCode, 404);
    const editKey = randomUUID();
    const editPayload = {
        body: 'Исправленное первое сообщение',
        messageVersion: 1,
        expectedVersion: 1,
        idempotencyKey: editKey,
    };
    const supportEdit = await catalogRequest(
        'PATCH',
        `/api/v1/support/${supportTicket.ticket.id}/messages/${supportMessageId}`,
        editPayload,
    );
    assert.equal(supportEdit.statusCode, 200, supportEdit.body);
    assert.equal(supportEdit.json().data.ticket.version, 2);
    assert.equal(supportEdit.json().data.messages[0].version, 2);
    assert.equal(supportEdit.json().data.messages[0].edited, true);
    const editReplay = await catalogRequest(
        'PATCH',
        `/api/v1/support/${supportTicket.ticket.id}/messages/${supportMessageId}`,
        editPayload,
    );
    assert.equal(editReplay.statusCode, 200, editReplay.body);
    assert.equal(
        (
            await catalogRequest('PATCH', `/api/v1/support/${supportTicket.ticket.id}/messages/${supportMessageId}`, {
                ...editPayload,
                body: 'Изменённый replay',
            })
        ).statusCode,
        409,
    );
    const userSupportReplyKey = randomUUID();
    const supportReplyPayload = {
        body: 'Второе сообщение пользователя',
        attachments: [],
        expectedVersion: 2,
        idempotencyKey: userSupportReplyKey,
    };
    const supportReply = await catalogRequest(
        'POST',
        `/api/v1/support/${supportTicket.ticket.id}/reply`,
        supportReplyPayload,
    );
    assert.equal(supportReply.statusCode, 200, supportReply.body);
    assert.equal(supportReply.json().data.ticket.version, 3);
    assert.equal(supportReply.json().data.ticket.status, 'waiting_for_support');
    assert.equal(supportReply.json().data.messages.length, 2);
    const supportClosePayload = { expectedVersion: 3, idempotencyKey: randomUUID() };
    const supportClose = await catalogRequest(
        'POST',
        `/api/v1/support/${supportTicket.ticket.id}/close`,
        supportClosePayload,
    );
    assert.equal(supportClose.statusCode, 200, supportClose.body);
    assert.equal(supportClose.json().data.ticket.status, 'closed');
    assert.equal(supportClose.json().data.ticket.version, 4);
    assert.ok(supportClose.json().data.ticket.closedAt);
    assert.equal(
        (
            await catalogRequest('POST', `/api/v1/support/${supportTicket.ticket.id}/reply`, {
                ...supportReplyPayload,
                expectedVersion: 4,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        409,
    );
    const supportReopenPayload = { expectedVersion: 4, idempotencyKey: randomUUID() };
    const supportReopen = await catalogRequest(
        'POST',
        `/api/v1/support/${supportTicket.ticket.id}/reopen`,
        supportReopenPayload,
    );
    assert.equal(supportReopen.statusCode, 200, supportReopen.body);
    assert.equal(supportReopen.json().data.ticket.status, 'waiting_for_support');
    assert.equal(supportReopen.json().data.ticket.version, 5);
    assert.equal(supportReopen.json().data.ticket.closedAt, null);
    const supportEffects = await pool.query(
        `select t.version::int,t.status,t.closed_at,
           (select count(*)::int from meal.support_messages where ticket_id=t.id) messages,
           (select max(version)::int from meal.support_messages where id=$2) edited_message_version,
           (select count(*)::int from meal.support_events where ticket_id=t.id and kind='message_edit') edit_events,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and target_binding in ('new',t.id::text,$2::text)) idempotency
         from meal.support_tickets t where t.id=$1`,
        [supportTicket.ticket.id, supportMessageId, `user:${userId}`],
    );
    assert.deepEqual(supportEffects.rows[0], {
        version: 5,
        status: 'waiting_for_support',
        closed_at: null,
        messages: 2,
        edited_message_version: 2,
        edit_events: 1,
        idempotency: 5,
    });
    console.log(
        `SUPPORT_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'support-live-happy-path-v1',
            operationIds: [
                'SupportController_meta',
                'SupportController_list',
                'SupportController_create',
                'SupportController_detail',
                'SupportController_reply',
                'SupportController_edit',
                'SupportController_close',
                'SupportController_reopen',
            ],
            effects: supportEffects.rows[0],
            assertions: {
                ownerIsolation: true,
                attachmentFailClosed: true,
                idempotentReplay: true,
                changedReplayConflict: true,
                optimisticVersion: true,
                editAudit: true,
                closeReopen: true,
                databaseEffects: true,
            },
        })}`,
    );

    const financePro = await addSubscription('pro', 'paid');
    assert.equal((await entitlement('pro', 'personal')).capabilities.finance, true);
    const financeRequest = (method, url, payload, extraHeaders = {}) =>
        app.inject({
            method,
            url,
            headers: { ...headers(), ...extraHeaders },
            ...(payload === undefined ? {} : { payload }),
        });
    const financeFrom = '2026-10-01';
    const financeTo = '2026-10-31';
    const expenseCreateKey = randomUUID();
    const expenseCreatePayload = {
        category: 'groceries',
        amountMinor: 12_550,
        occurredAt: '2026-10-08T08:30:00.000Z',
        financeConsent: true,
        idempotencyKey: expenseCreateKey,
    };
    const createdExpense = await financeRequest('POST', '/api/v1/finance/expenses', expenseCreatePayload);
    assert.equal(createdExpense.statusCode, 200, createdExpense.body);
    assert.equal(createdExpense.json().data.access.mode, 'active');
    assert.equal(createdExpense.json().data.expense.version, 1);
    const expenseId = createdExpense.json().data.expense.id;
    const expenseCreateReplay = await financeRequest('POST', '/api/v1/finance/expenses', expenseCreatePayload);
    assert.equal(expenseCreateReplay.statusCode, 200, expenseCreateReplay.body);
    assert.deepEqual(expenseCreateReplay.json().data, createdExpense.json().data);
    assert.equal(
        (
            await financeRequest('POST', '/api/v1/finance/expenses', {
                ...expenseCreatePayload,
                amountMinor: 12_551,
            })
        ).statusCode,
        409,
    );
    const expenseUpdateKey = randomUUID();
    const expenseUpdatePayload = {
        category: 'restaurant',
        amountMinor: 13_000,
        occurredAt: '2026-10-09T09:00:00.000Z',
        expectedVersion: 1,
        idempotencyKey: expenseUpdateKey,
    };
    const updatedExpense = await financeRequest('PUT', `/api/v1/finance/expenses/${expenseId}`, expenseUpdatePayload, {
        'if-match': '"1"',
    });
    assert.equal(updatedExpense.statusCode, 200, updatedExpense.body);
    assert.equal(updatedExpense.json().data.expense.version, 2);
    assert.equal(updatedExpense.json().data.expense.amountMinor, 13_000);
    const expenseUpdateReplay = await financeRequest(
        'PUT',
        `/api/v1/finance/expenses/${expenseId}`,
        expenseUpdatePayload,
        { 'if-match': '"1"' },
    );
    assert.equal(expenseUpdateReplay.statusCode, 200, expenseUpdateReplay.body);
    assert.deepEqual(expenseUpdateReplay.json().data, updatedExpense.json().data);
    assert.equal(
        (
            await financeRequest(
                'PUT',
                `/api/v1/finance/expenses/${expenseId}`,
                { ...expenseUpdatePayload, amountMinor: 13_001, idempotencyKey: randomUUID() },
                { 'if-match': '"1"' },
            )
        ).statusCode,
        412,
    );
    const expenses = await financeRequest(
        'GET',
        `/api/v1/finance/expenses?from=${financeFrom}&to=${financeTo}&category=restaurant`,
    );
    assert.equal(expenses.statusCode, 200, expenses.body);
    assert.deepEqual(
        expenses.json().data.items.map((item) => item.id),
        [expenseId],
    );
    assert.equal(expenses.json().data.totalMinor, 13_000);
    const expenseDetail = await financeRequest('GET', `/api/v1/finance/expenses/${expenseId}`);
    assert.equal(expenseDetail.statusCode, 200, expenseDetail.body);
    assert.equal(expenseDetail.json().data.expense.category, 'restaurant');
    assert.equal((await financeRequest('GET', `/api/v1/finance/expenses/${randomUUID()}`)).statusCode, 404);

    const budgetCreateKey = randomUUID();
    const budgetCreatePayload = {
        amountMinor: 500_000,
        startsOn: financeFrom,
        endsOn: financeTo,
        category: null,
        idempotencyKey: budgetCreateKey,
    };
    const createdBudget = await financeRequest('POST', '/api/v1/finance/budgets', budgetCreatePayload);
    assert.equal(createdBudget.statusCode, 200, createdBudget.body);
    assert.equal(createdBudget.json().data.budget.version, 1);
    const budgetId = createdBudget.json().data.budget.id;
    assert.equal(
        (await financeRequest('POST', '/api/v1/finance/budgets', budgetCreatePayload)).json().data.budget.id,
        budgetId,
    );
    assert.equal(
        (
            await financeRequest('POST', '/api/v1/finance/budgets', {
                ...budgetCreatePayload,
                amountMinor: 500_001,
            })
        ).statusCode,
        409,
    );
    assert.equal(
        (
            await financeRequest('POST', '/api/v1/finance/budgets', {
                ...budgetCreatePayload,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        409,
    );
    const budgetUpdateKey = randomUUID();
    const budgetUpdatePayload = {
        amountMinor: 600_000,
        startsOn: financeFrom,
        endsOn: financeTo,
        category: null,
        expectedVersion: 1,
        idempotencyKey: budgetUpdateKey,
    };
    const updatedBudget = await financeRequest('PUT', `/api/v1/finance/budgets/${budgetId}`, budgetUpdatePayload, {
        'if-match': '"1"',
    });
    assert.equal(updatedBudget.statusCode, 200, updatedBudget.body);
    assert.equal(updatedBudget.json().data.budget.amountMinor, 600_000);
    assert.equal(updatedBudget.json().data.budget.version, 2);
    assert.equal(
        (
            await financeRequest(
                'PUT',
                `/api/v1/finance/budgets/${budgetId}`,
                { ...budgetUpdatePayload, amountMinor: 600_001, idempotencyKey: randomUUID() },
                { 'if-match': '"1"' },
            )
        ).statusCode,
        412,
    );
    const budgets = await financeRequest('GET', '/api/v1/finance/budgets');
    assert.equal(budgets.statusCode, 200, budgets.body);
    assert.equal(budgets.json().data.supportsCategoryBudgets, false);
    assert.deepEqual(
        budgets.json().data.items.map((item) => item.id),
        [budgetId],
    );
    const analytics = await financeRequest(
        'GET',
        `/api/v1/finance/analytics?from=${financeFrom}&to=${financeTo}&category=restaurant`,
    );
    assert.equal(analytics.statusCode, 200, analytics.body);
    assert.equal(analytics.json().data.totals.expenseMinor, 13_000);
    assert.equal(analytics.json().data.totals.expenseCount, 1);
    assert.equal(analytics.json().data.totals.receiptCount, 0);
    assert.equal(analytics.json().data.totals.confirmedSavingsMinor, null);
    assert.equal(analytics.json().data.forecast.reason, 'insufficient_history');
    const financeOverview = await financeRequest('GET', `/api/v1/finance/overview?from=${financeFrom}&to=${financeTo}`);
    assert.equal(financeOverview.statusCode, 200, financeOverview.body);
    assert.equal(financeOverview.json().data.expenseCount, 1);
    assert.equal(financeOverview.json().data.totalMinor, 13_000);
    assert.equal(financeOverview.json().data.budget.amountMinor, 600_000);
    assert.equal(financeOverview.json().data.budgetSpentMinor, 13_000);
    assert.equal(financeOverview.json().data.budgetRemainingMinor, 587_000);

    const priceCatalog = await financeRequest('GET', '/api/v1/finance/prices/catalog');
    assert.equal(priceCatalog.statusCode, 200, priceCatalog.body);
    assert.equal(
        priceCatalog.json().data.items.some((item) => item.ingredientId === activeFinanceIngredientId),
        true,
    );
    const priceCreateKey = randomUUID();
    const priceCreatePayload = {
        ingredientId: activeFinanceIngredientId,
        unit: 'g',
        quantity: '500',
        amountMinor: 12_999,
        observedAt: '2026-10-08T10:00:00.000Z',
        financeConsent: true,
        idempotencyKey: priceCreateKey,
    };
    const createdPrice = await financeRequest('POST', '/api/v1/finance/prices', priceCreatePayload);
    assert.equal(createdPrice.statusCode, 200, createdPrice.body);
    assert.equal(createdPrice.json().data.observation.amountMinor, 12_999);
    assert.equal(createdPrice.json().data.observation.eligibleForAggregate, false);
    assert.equal(createdPrice.json().data.resolved.amountMinor, 26);
    assert.equal(createdPrice.json().data.resolved.source, 'personal_latest');
    const priceObservationId = createdPrice.json().data.observation.id;
    const priceReplay = await financeRequest('POST', '/api/v1/finance/prices', priceCreatePayload);
    assert.equal(priceReplay.statusCode, 200, priceReplay.body);
    assert.equal(priceReplay.json().data.observation.id, priceObservationId);
    assert.equal(
        (
            await financeRequest('POST', '/api/v1/finance/prices', {
                ...priceCreatePayload,
                amountMinor: 13_000,
            })
        ).statusCode,
        409,
    );
    const priceList = await financeRequest('GET', '/api/v1/finance/prices');
    assert.equal(priceList.statusCode, 200, priceList.body);
    assert.deepEqual(
        priceList.json().data.items.map((item) => item.id),
        [priceObservationId],
    );
    assert.equal(priceList.json().data.resolved[0].amountMinor, 26);

    const financeEffects = await pool.query(
        `select
           (select count(*)::int from meal.expenses where id=$1 and kind='restaurant' and amount_minor=13000 and version=2) expenses,
           (select count(*)::int from meal.budgets where id=$2 and amount_minor=600000 and version=2) budgets,
           (select count(*)::int from meal.price_observations where id=$3 and eligible_for_aggregate=false) prices,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$4 and key=any($5::text[])) idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$6 and request_id::text=any($5::text[])) audits`,
        [
            expenseId,
            budgetId,
            priceObservationId,
            `user:${userId}`,
            [expenseCreateKey, expenseUpdateKey, budgetCreateKey, budgetUpdateKey, priceCreateKey],
            userId,
        ],
    );
    assert.deepEqual(financeEffects.rows[0], { expenses: 1, budgets: 1, prices: 1, idempotency: 5, audits: 5 });

    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `update meal.subscription_periods
                 set starts_at=now()-interval '1 day',
                     ends_at=(select created_at+interval '1 microsecond' from meal.price_observations where id=$2),
                     version=version+1
                 where id=$1`,
                [financePro.periodId, priceObservationId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const formerFinanceExpenses = await financeRequest(
        'GET',
        `/api/v1/finance/expenses?from=${financeFrom}&to=${financeTo}`,
    );
    assert.equal(formerFinanceExpenses.statusCode, 200, formerFinanceExpenses.body);
    assert.equal(formerFinanceExpenses.json().data.access.mode, 'read_only');
    assert.deepEqual(
        formerFinanceExpenses.json().data.items.map((item) => item.id),
        [expenseId],
    );
    const formerPrices = await financeRequest('GET', '/api/v1/finance/prices');
    assert.equal(formerPrices.statusCode, 200, formerPrices.body);
    assert.equal(formerPrices.json().data.access.mode, 'read_only');
    assert.deepEqual(
        formerPrices.json().data.items.map((item) => item.id),
        [priceObservationId],
    );
    assert.equal((await financeRequest('POST', '/api/v1/finance/expenses', expenseCreatePayload)).statusCode, 403);
    assert.equal((await financeRequest('POST', '/api/v1/finance/budgets', budgetCreatePayload)).statusCode, 403);
    assert.equal((await financeRequest('POST', '/api/v1/finance/prices', priceCreatePayload)).statusCode, 403);
    assert.deepEqual(
        (
            await pool.query(
                `select
                   (select count(*)::int from meal.expenses where id=$1) expenses,
                   (select count(*)::int from meal.budgets where id=$2) budgets,
                   (select count(*)::int from meal.price_observations where id=$3) prices,
                   (select count(*)::int from meal.idempotency_records where actor_namespace=$4 and key=any($5::text[])) idempotency,
                   (select count(*)::int from meal.audit_events where actor_id=$6 and request_id::text=any($5::text[])) audits`,
                [
                    expenseId,
                    budgetId,
                    priceObservationId,
                    `user:${userId}`,
                    [expenseCreateKey, expenseUpdateKey, budgetCreateKey, budgetUpdateKey, priceCreateKey],
                    userId,
                ],
            )
        ).rows[0],
        { expenses: 1, budgets: 1, prices: 1, idempotency: 5, audits: 5 },
    );
    console.log(
        `FINANCE_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'finance-live-happy-path-v1',
            operationIds: [
                'FinanceController_analytics',
                'FinanceController_expenses',
                'FinanceController_createExpense',
                'FinanceController_expense',
                'FinanceController_updateExpense',
                'FinanceController_budgets',
                'FinanceController_createBudget',
                'FinanceController_updateBudget',
                'PricingController_catalog',
                'PricingController_list',
                'PricingController_create',
            ],
            effects: financeEffects.rows[0],
            assertions: {
                activeProSuccess: true,
                ownerIsolation: true,
                idempotentReplay: true,
                changedReplayConflict: true,
                optimisticVersion: true,
                aggregateReadback: true,
                formerProReadOnly: true,
                databaseEffects: true,
            },
        })}`,
    );

    // Operation-specific HTTP acceptance for every InventoryController route. This deliberately
    // exercises the discriminated command/location variants against PostgreSQL instead of treating
    // the generic authenticated-boundary sweep below as happy-path evidence.
    let inventoryRequestIndex = 0;
    const inventoryRequest = (method, url, payload, extraHeaders = {}) =>
        app.inject({
            method,
            url,
            headers: { ...headers(), ...extraHeaders },
            remoteAddress: `198.23.0.${++inventoryRequestIndex}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const expectInventoryError = (response, status, label) => {
        assert.equal(response.statusCode, status, `${label}: ${response.body}`);
        assert.equal(errorEnvelopeSchema.safeParse(response.json()).success, true, `${label}: error envelope`);
    };
    const locationCreateKey = randomUUID();
    const locationRenameKey = randomUUID();
    const secondLocationCreateKey = randomUUID();
    const firstLocationPayload = {
        action: 'create',
        name: `Acceptance pantry ${suffix}`,
        type: 'pantry',
        scope: 'private',
        idempotencyKey: locationCreateKey,
    };
    const firstLocationResponse = await inventoryRequest('POST', '/api/v1/inventory-locations', firstLocationPayload);
    assert.equal(firstLocationResponse.statusCode, 200, firstLocationResponse.body);
    const firstLocation = firstLocationResponse.json().data.location;
    assert.equal(firstLocation.version, 1);
    const firstLocationReplay = await inventoryRequest('POST', '/api/v1/inventory-locations', firstLocationPayload);
    assert.equal(firstLocationReplay.statusCode, 200, firstLocationReplay.body);
    assert.deepEqual(firstLocationReplay.json().data.location, firstLocation);
    expectInventoryError(
        await inventoryRequest('POST', '/api/v1/inventory-locations', {
            ...firstLocationPayload,
            name: `Changed pantry ${suffix}`,
        }),
        409,
        'inventory location changed replay',
    );
    const renamedLocationResponse = await inventoryRequest(
        'POST',
        '/api/v1/inventory-locations',
        {
            action: 'rename',
            id: firstLocation.id,
            name: `Acceptance pantry renamed ${suffix}`,
            version: 1,
            scope: 'private',
            idempotencyKey: locationRenameKey,
        },
        { 'if-match': '"1"' },
    );
    assert.equal(renamedLocationResponse.statusCode, 200, renamedLocationResponse.body);
    const renamedLocation = renamedLocationResponse.json().data.location;
    assert.equal(renamedLocation.id, firstLocation.id);
    assert.equal(renamedLocation.version, 2);

    const secondLocationResponse = await inventoryRequest('POST', '/api/v1/inventory-locations', {
        action: 'create',
        name: `Acceptance fridge ${suffix}`,
        type: 'fridge',
        scope: 'private',
        idempotencyKey: secondLocationCreateKey,
    });
    assert.equal(secondLocationResponse.statusCode, 200, secondLocationResponse.body);
    const secondLocation = secondLocationResponse.json().data.location;
    const locationsResponse = await inventoryRequest('GET', '/api/v1/inventory-locations?scope=private');
    assert.equal(locationsResponse.statusCode, 200, locationsResponse.body);
    const acceptanceLocations = locationsResponse
        .json()
        .data.items.filter((item) => [firstLocation.id, secondLocation.id].includes(item.id));
    assert.deepEqual(
        acceptanceLocations.map((item) => [item.id, item.version]).sort(),
        [
            [firstLocation.id, 2],
            [secondLocation.id, 1],
        ].sort(),
    );

    const batchCreateKey = randomUUID();
    const batchName = `Acceptance inventory ${suffix} main`;
    const batchCreatePayload = {
        scope: 'private',
        ingredientId: largeTenantIngredientId,
        idempotencyKey: batchCreateKey,
        name: batchName,
        quantity: '5',
        unit: 'pcs',
        locationId: firstLocation.id,
        openedAt: null,
        purchasedOn: null,
        expiryOn: null,
        packageState: 'sealed',
        precision: 'exact',
        quantitySource: 'user',
        confidence: 1,
        pricePaidRub: '250',
        storeName: 'Acceptance store',
        barcode: `ACC-${suffix}`,
    };
    const batchCreateResponse = await inventoryRequest('POST', '/api/v1/inventory', batchCreatePayload);
    assert.equal(batchCreateResponse.statusCode, 200, batchCreateResponse.body);
    const createdBatch = batchCreateResponse.json().data.batch;
    assert.equal(createdBatch.version, 1);
    assert.equal(createdBatch.quantity, '5');
    const batchCreateReplay = await inventoryRequest('POST', '/api/v1/inventory', batchCreatePayload);
    assert.equal(batchCreateReplay.statusCode, 200, batchCreateReplay.body);
    assert.equal(batchCreateReplay.json().data.batch.id, createdBatch.id);
    expectInventoryError(
        await inventoryRequest('POST', '/api/v1/inventory', {
            ...batchCreatePayload,
            name: `${batchName} changed replay`,
        }),
        409,
        'inventory create changed replay',
    );

    const detailResponse = await inventoryRequest('GET', `/api/v1/inventory/${createdBatch.id}?scope=private`);
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detailedBatch = detailResponse.json().data.batch;
    assert.equal(detailedBatch.id, createdBatch.id);
    assert.equal(detailedBatch.name, createdBatch.name);
    assert.equal(detailedBatch.version, createdBatch.version);
    assert.equal(Number(detailedBatch.quantity), Number(createdBatch.quantity));
    const listResponse = await inventoryRequest(
        'GET',
        `/api/v1/inventory?localDate=2026-10-14&scope=private&q=${encodeURIComponent(batchName)}`,
    );
    assert.equal(listResponse.statusCode, 200, listResponse.body);
    assert.equal(listResponse.json().data.total, 1);
    assert.equal(listResponse.json().data.items[0].id, createdBatch.id);

    const commandKeys = {
        edit: randomUUID(),
        consume: randomUUID(),
        transfer: randomUUID(),
        archive: randomUUID(),
        restore: randomUUID(),
    };
    const editedName = `Acceptance inventory ${suffix} edited`;
    const editResponse = await inventoryRequest(
        'POST',
        `/api/v1/inventory/${createdBatch.id}/command`,
        {
            action: 'edit',
            version: 1,
            scope: 'private',
            idempotencyKey: commandKeys.edit,
            fields: {
                name: editedName,
                quantity: '4.5',
                unit: 'pcs',
                locationId: firstLocation.id,
                openedAt: null,
                purchasedOn: null,
                expiryOn: null,
                packageState: 'opened',
                precision: 'estimated',
                quantitySource: 'user',
                confidence: 0.9,
                pricePaidRub: '240',
                storeName: 'Acceptance store edited',
                barcode: `ACC-${suffix}`,
            },
        },
        { 'if-match': '"1"' },
    );
    assert.equal(editResponse.statusCode, 200, editResponse.body);
    assert.equal(editResponse.json().data.batch.version, 2);
    assert.equal(editResponse.json().data.batch.name, editedName);

    const staleKey = randomUUID();
    const effectsBeforeStale = await pool.query(
        `select
           (select count(*)::int from meal.inventory_movements where batch_id=$1) movements,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and key=$3) idempotency`,
        [createdBatch.id, `user:${userId}`, staleKey],
    );
    expectInventoryError(
        await inventoryRequest(
            'POST',
            `/api/v1/inventory/${createdBatch.id}/command`,
            {
                action: 'consume',
                quantity: '0.5',
                version: 1,
                scope: 'private',
                idempotencyKey: staleKey,
            },
            { 'if-match': '"1"' },
        ),
        412,
        'inventory stale command',
    );
    const effectsAfterStale = await pool.query(
        `select
           (select count(*)::int from meal.inventory_movements where batch_id=$1) movements,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and key=$3) idempotency,
           (select version::int from meal.inventory_batches where id=$1) version`,
        [createdBatch.id, `user:${userId}`, staleKey],
    );
    assert.equal(effectsAfterStale.rows[0].movements, effectsBeforeStale.rows[0].movements);
    assert.equal(effectsAfterStale.rows[0].idempotency, 0);
    assert.equal(effectsAfterStale.rows[0].version, 2);

    const command = async (action, version, payload, key, expected) => {
        const response = await inventoryRequest(
            'POST',
            `/api/v1/inventory/${createdBatch.id}/command`,
            { action, version, scope: 'private', idempotencyKey: key, ...payload },
            { 'if-match': `"${version}"` },
        );
        assert.equal(response.statusCode, 200, `${action}: ${response.body}`);
        const batch = response.json().data.batch;
        assert.equal(batch.version, version + 1, `${action}: version`);
        for (const [field, value] of Object.entries(expected)) assert.equal(batch[field], value, `${action}: ${field}`);
        const replay = await inventoryRequest(
            'POST',
            `/api/v1/inventory/${createdBatch.id}/command`,
            { action, version, scope: 'private', idempotencyKey: key, ...payload },
            { 'if-match': `"${version}"` },
        );
        assert.equal(replay.statusCode, 200, `${action} replay: ${replay.body}`);
        assert.deepEqual(replay.json().data.batch, batch, `${action}: replay snapshot`);
        return batch;
    };
    await command('consume', 2, { quantity: '0.5' }, commandKeys.consume, { quantity: '4' });
    await command('transfer', 3, { locationId: secondLocation.id }, commandKeys.transfer, {
        locationId: secondLocation.id,
    });
    await command('archive', 4, {}, commandKeys.archive, { version: 5 });
    const archivedList = await inventoryRequest(
        'GET',
        `/api/v1/inventory?localDate=2026-10-14&scope=private&status=archived&q=${encodeURIComponent(editedName)}`,
    );
    assert.equal(archivedList.statusCode, 200, archivedList.body);
    assert.equal(archivedList.json().data.total, 1);
    const activeWhileArchived = await inventoryRequest(
        'GET',
        `/api/v1/inventory?localDate=2026-10-14&scope=private&status=active&q=${encodeURIComponent(editedName)}`,
    );
    assert.equal(activeWhileArchived.statusCode, 200, activeWhileArchived.body);
    assert.equal(activeWhileArchived.json().data.total, 0);
    await command('restore', 5, {}, commandKeys.restore, { archivedAt: null });

    const historyResponse = await inventoryRequest(
        'GET',
        `/api/v1/inventory-history?scope=private&batchId=${createdBatch.id}&limit=100&offset=0`,
    );
    assert.equal(historyResponse.statusCode, 200, historyResponse.body);
    assert.equal(historyResponse.json().data.total, 6);
    assert.deepEqual([...new Set(historyResponse.json().data.items.map((item) => item.action))].sort(), [
        'adjust',
        'archive',
        'consume',
        'purchase',
        'restore',
        'transfer',
    ]);

    const importKey = randomUUID();
    const importedRows = [1, 2].map((index) => ({
        ...batchCreatePayload,
        idempotencyKey: randomUUID(),
        name: `Acceptance inventory ${suffix} import ${index}`,
        quantity: String(index),
        locationId: secondLocation.id,
        barcode: null,
    }));
    const importPayload = { rows: importedRows, idempotencyKey: importKey };
    const importResponse = await inventoryRequest('POST', '/api/v1/inventory/import/commit', importPayload);
    assert.equal(importResponse.statusCode, 200, importResponse.body);
    const importedItems = importResponse.json().data.items;
    assert.equal(importedItems.length, 2);
    const importReplay = await inventoryRequest('POST', '/api/v1/inventory/import/commit', importPayload);
    assert.equal(importReplay.statusCode, 200, importReplay.body);
    assert.deepEqual(
        importReplay.json().data.items.map((item) => item.id),
        importedItems.map((item) => item.id),
    );
    expectInventoryError(
        await inventoryRequest('POST', '/api/v1/inventory/import/commit', {
            ...importPayload,
            rows: [{ ...importedRows[0], name: `${importedRows[0].name} changed` }, importedRows[1]],
        }),
        409,
        'inventory import changed replay',
    );

    const inventoryKeys = [
        locationCreateKey,
        locationRenameKey,
        secondLocationCreateKey,
        batchCreateKey,
        ...Object.values(commandKeys),
        importKey,
    ];
    const acceptedBatchIds = [createdBatch.id, ...importedItems.map((item) => item.id)];
    const inventoryEffects = await pool.query(
        `select
           (select count(*)::int from meal.inventory_batches where id=any($1::uuid[])) batches,
           (select count(*)::int from meal.inventory_movements where batch_id=any($1::uuid[])) movements,
           (select count(distinct operation_id)::int from meal.inventory_movements where batch_id=any($1::uuid[])) operations,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and key=any($3::text[])) idempotency,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$2 and key=$4) stale_idempotency`,
        [acceptedBatchIds, `user:${userId}`, inventoryKeys, staleKey],
    );
    assert.deepEqual(inventoryEffects.rows[0], {
        batches: 3,
        movements: 8,
        operations: 7,
        idempotency: 10,
        stale_idempotency: 0,
    });
    const finalBatch = await pool.query(
        `select name,quantity::text,location_id,version::int,archived_at from meal.inventory_batches where id=$1`,
        [createdBatch.id],
    );
    assert.equal(finalBatch.rows[0].name, editedName);
    assert.equal(Number(finalBatch.rows[0].quantity), 4);
    assert.equal(finalBatch.rows[0].location_id, secondLocation.id);
    assert.equal(finalBatch.rows[0].version, 6);
    assert.equal(finalBatch.rows[0].archived_at, null);
    const inventoryEvidence = {
        schema: 'inventory-live-happy-path-v1',
        operationIds: [
            'InventoryController_list',
            'InventoryController_create',
            'InventoryController_locations',
            'InventoryController_location',
            'InventoryController_history',
            'InventoryController_detail',
            'InventoryController_importMany',
            'InventoryController_command',
        ],
        variants: {
            location: ['create', 'rename'],
            command: ['edit', 'consume', 'transfer', 'archive', 'restore'],
        },
        effects: inventoryEffects.rows[0],
        replay: { create: true, import: true, location: true, commands: 5 },
        rollback: { staleVersion: true, changedReplay: true },
    };

    await runShoppingReceiptsAcceptance({
        app,
        pool,
        ownerPool,
        frontendOrigin: config.FRONTEND_ORIGIN,
        headers,
        userId,
        suffix,
        ingredientId: largeTenantIngredientId,
        locationId: firstLocation.id,
        recipeId: publicRecipe.recipeId,
        plusSubscriptionId: plusSubscription.subscriptionId,
        proSubscriptionId: proSubscription.subscriptionId,
    });

    await runPlanningPreservesCookingAcceptance({
        app,
        pool,
        ownerPool,
        frontendOrigin: config.FRONTEND_ORIGIN,
        headers,
        userId,
        suffix,
        ingredientId: largeTenantIngredientId,
        locationId: firstLocation.id,
        recipeId: publicRecipe.recipeId,
        revisionId: publicRecipe.revisionId,
        plusSubscriptionId: plusSubscription.subscriptionId,
        proSubscriptionId: proSubscription.subscriptionId,
    });

    const notificationIds = {
        security: randomUUID(),
        inventoryUnread: randomUUID(),
        inventoryRead: randomUUID(),
        future: randomUUID(),
        foreign: randomUUID(),
    };
    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.notifications(
                   id,category,priority,payload_minimized,dedup_key,available_at,read_at,user_id
                 ) values
                   ($1,'security','critical',$2::jsonb,$3,now()-interval '5 minutes',null,$4),
                   ($5,'inventory','important',$6::jsonb,$7,now()-interval '4 minutes',null,$4),
                   ($8,'inventory','informational',$9::jsonb,$10,now()-interval '3 minutes',now()-interval '2 minutes',$4),
                   ($11,'security','informational',$12::jsonb,$13,now()+interval '1 day',null,$4),
                   ($14,'security','critical',$15::jsonb,$16,now()-interval '2 minutes',null,$17)`,
                [
                    notificationIds.security,
                    JSON.stringify({
                        title: 'Проверка безопасности',
                        body: 'Важное событие',
                        href: '/settings/security',
                    }),
                    `acceptance:${suffix}:security`,
                    userId,
                    notificationIds.inventoryUnread,
                    JSON.stringify({ title: 'Проверьте запасы', body: 'Осталось мало продукта' }),
                    `acceptance:${suffix}:inventory-unread`,
                    notificationIds.inventoryRead,
                    JSON.stringify({ title: 'Запасы обновлены', body: 'Событие уже прочитано' }),
                    `acceptance:${suffix}:inventory-read`,
                    notificationIds.future,
                    JSON.stringify({ title: 'Будущее событие', body: 'Пока не показывать' }),
                    `acceptance:${suffix}:future`,
                    notificationIds.foreign,
                    JSON.stringify({ title: 'Чужое событие', body: 'Не должно быть доступно' }),
                    `acceptance:${suffix}:foreign`,
                    secondModeratorId,
                ],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const notificationRequest = (method, url, payload) =>
        app.inject({
            method,
            url,
            headers: headers(),
            ...(payload === undefined ? {} : { payload }),
        });
    const expectNotificationError = (response, status, label) => {
        assert.equal(response.statusCode, status, `${label}: ${response.body}`);
        assert.equal(errorEnvelopeSchema.safeParse(response.json()).success, true, `${label}: error envelope`);
    };

    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/notification-preferences' })).statusCode, 401);
    await revokeSpecialCategory(3);

    const defaultNotificationPreferences = await notificationRequest('GET', '/api/v1/notification-preferences');
    assert.equal(defaultNotificationPreferences.statusCode, 200, defaultNotificationPreferences.body);
    assert.equal(defaultNotificationPreferences.json().data.categories.length, 12);
    assert.equal(defaultNotificationPreferences.json().data.version, 1);
    assert.deepEqual(defaultNotificationPreferences.json().data.deliveryAvailable, { push: false, email: false });
    assert.equal(
        defaultNotificationPreferences.json().data.categories.every((item) => !item.push && !item.email),
        true,
    );
    const notificationPreferenceKey = randomUUID();
    const notificationPreferencePayload = {
        categories: defaultNotificationPreferences.json().data.categories.map((item, index) => ({
            category: item.category,
            push: index % 2 === 0,
            email: index % 3 === 0,
        })),
        quietHours: { start: '21:30', end: '07:15' },
        planReminderTime: '08:45',
        timezone: 'Asia/Yekaterinburg',
        urgentFoodRisk: true,
        expectedVersion: 1,
        idempotencyKey: notificationPreferenceKey,
    };
    const updatedNotificationPreferences = await notificationRequest(
        'PUT',
        '/api/v1/notification-preferences',
        notificationPreferencePayload,
    );
    assert.equal(updatedNotificationPreferences.statusCode, 200, updatedNotificationPreferences.body);
    assert.equal(updatedNotificationPreferences.json().data.version, 2);
    assert.deepEqual(updatedNotificationPreferences.json().data.deliveryAvailable, { push: false, email: false });
    const notificationPreferenceReplay = await notificationRequest(
        'PUT',
        '/api/v1/notification-preferences',
        notificationPreferencePayload,
    );
    assert.equal(notificationPreferenceReplay.statusCode, 200, notificationPreferenceReplay.body);
    assert.deepEqual(notificationPreferenceReplay.json().data, updatedNotificationPreferences.json().data);
    expectNotificationError(
        await notificationRequest('PUT', '/api/v1/notification-preferences', {
            ...notificationPreferencePayload,
            timezone: 'Europe/Moscow',
        }),
        409,
        'notification preferences changed replay',
    );
    const stalePreferenceKey = randomUUID();
    expectNotificationError(
        await notificationRequest('PUT', '/api/v1/notification-preferences', {
            ...notificationPreferencePayload,
            idempotencyKey: stalePreferenceKey,
        }),
        412,
        'notification preferences stale version',
    );
    const notificationPreferencesReadback = await notificationRequest('GET', '/api/v1/notification-preferences');
    assert.equal(notificationPreferencesReadback.statusCode, 200, notificationPreferencesReadback.body);
    assert.deepEqual(notificationPreferencesReadback.json().data, updatedNotificationPreferences.json().data);

    const notificationList = await notificationRequest(
        'GET',
        '/api/v1/notifications?category=all&unread=0&limit=100&offset=0',
    );
    assert.equal(notificationList.statusCode, 200, notificationList.body);
    assert.equal(notificationList.json().data.total, 3);
    assert.equal(notificationList.json().data.unreadCount, 2);
    assert.equal(notificationList.json().data.categoryCounts.security, 1);
    assert.equal(notificationList.json().data.categoryCounts.inventory, 2);
    assert.deepEqual(
        new Set(notificationList.json().data.items.map((item) => item.id)),
        new Set([notificationIds.security, notificationIds.inventoryUnread, notificationIds.inventoryRead]),
    );
    assert.equal(
        notificationList.json().data.items.some((item) => item.id === notificationIds.future),
        false,
    );
    assert.equal(
        notificationList.json().data.items.some((item) => item.id === notificationIds.foreign),
        false,
    );
    const inventoryUnreadList = await notificationRequest(
        'GET',
        '/api/v1/notifications?category=inventory&unread=1&limit=1&offset=0',
    );
    assert.equal(inventoryUnreadList.statusCode, 200, inventoryUnreadList.body);
    assert.equal(inventoryUnreadList.json().data.total, 1);
    assert.equal(inventoryUnreadList.json().data.items[0].id, notificationIds.inventoryUnread);

    const notificationReadKey = randomUUID();
    const notificationReadPayload = { expectedVersion: 1, idempotencyKey: notificationReadKey };
    const notificationRead = await notificationRequest(
        'POST',
        `/api/v1/notifications/${notificationIds.security}/read`,
        notificationReadPayload,
    );
    assert.equal(notificationRead.statusCode, 200, notificationRead.body);
    assert.equal(notificationRead.json().data.updated, 1);
    const notificationReadReplay = await notificationRequest(
        'POST',
        `/api/v1/notifications/${notificationIds.security}/read`,
        notificationReadPayload,
    );
    assert.equal(notificationReadReplay.statusCode, 200, notificationReadReplay.body);
    assert.deepEqual(notificationReadReplay.json().data, notificationRead.json().data);
    expectNotificationError(
        await notificationRequest('POST', `/api/v1/notifications/${notificationIds.security}/read`, {
            expectedVersion: 2,
            idempotencyKey: notificationReadKey,
        }),
        409,
        'notification read changed replay',
    );
    const staleNotificationReadKey = randomUUID();
    expectNotificationError(
        await notificationRequest('POST', `/api/v1/notifications/${notificationIds.security}/read`, {
            expectedVersion: 1,
            idempotencyKey: staleNotificationReadKey,
        }),
        412,
        'notification read stale version',
    );
    expectNotificationError(
        await notificationRequest('POST', `/api/v1/notifications/${notificationIds.foreign}/read`, {
            expectedVersion: 1,
            idempotencyKey: randomUUID(),
        }),
        404,
        'foreign notification isolation',
    );

    const notificationReadAllKey = randomUUID();
    const notificationReadAllPayload = { category: 'inventory', idempotencyKey: notificationReadAllKey };
    const notificationReadAll = await notificationRequest(
        'POST',
        '/api/v1/notifications/read-all',
        notificationReadAllPayload,
    );
    assert.equal(notificationReadAll.statusCode, 200, notificationReadAll.body);
    assert.equal(notificationReadAll.json().data.updated, 1);
    const notificationReadAllReplay = await notificationRequest(
        'POST',
        '/api/v1/notifications/read-all',
        notificationReadAllPayload,
    );
    assert.equal(notificationReadAllReplay.statusCode, 200, notificationReadAllReplay.body);
    assert.deepEqual(notificationReadAllReplay.json().data, notificationReadAll.json().data);

    const notificationEffects = await pool.query(
        `select
           (select count(*)::int from meal.notification_preferences where user_id=$1 and not(category='cooking' and channel='in_app')) preferences,
           (select min(version)::int from meal.notification_preferences where user_id=$1 and not(category='cooking' and channel='in_app')) preference_min_version,
           (select max(version)::int from meal.notification_preferences where user_id=$1 and not(category='cooking' and channel='in_app')) preference_max_version,
           (select count(*)::int from meal.notifications where id=any($2::uuid[]) and read_at is not null) read_notifications,
           (select count(*)::int from meal.notifications where id=$3 and read_at is null and version=1) future_unchanged,
           (select count(*)::int from meal.notifications where id=$4 and user_id=$5 and read_at is null and version=1) foreign_unchanged,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$6
             and operation in ('notifications.preferences','notifications.read','notifications.read-all')
             and key=any($7::text[])) idempotency,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$6
             and key=any($8::text[])) rejected_idempotency`,
        [
            userId,
            [notificationIds.security, notificationIds.inventoryUnread, notificationIds.inventoryRead],
            notificationIds.future,
            notificationIds.foreign,
            secondModeratorId,
            `user:${userId}`,
            [notificationPreferenceKey, notificationReadKey, notificationReadAllKey],
            [stalePreferenceKey, staleNotificationReadKey],
        ],
    );
    assert.deepEqual(notificationEffects.rows[0], {
        preferences: 24,
        preference_min_version: 2,
        preference_max_version: 2,
        read_notifications: 3,
        future_unchanged: 1,
        foreign_unchanged: 1,
        idempotency: 3,
        rejected_idempotency: 0,
    });
    const notificationsAfterRead = await notificationRequest(
        'GET',
        '/api/v1/notifications?category=all&unread=1&limit=100&offset=0',
    );
    assert.equal(notificationsAfterRead.statusCode, 200, notificationsAfterRead.body);
    assert.equal(notificationsAfterRead.json().data.total, 0);
    assert.equal(notificationsAfterRead.json().data.unreadCount, 0);
    await acceptSpecialCategory(4);
    console.log(
        `NOTIFICATIONS_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'notifications-live-happy-path-v1',
            operationIds: [
                'NotificationsController_preferences',
                'NotificationsController_updatePreferences',
                'NotificationsController_list',
                'NotificationsController_read',
                'NotificationsController_readAll',
            ],
            effects: notificationEffects.rows[0],
            assertions: {
                readback: true,
                databaseEffects: true,
                idempotentReplay: true,
                changedReplayConflict: true,
                staleVersionRollback: true,
                userIsolation: true,
                unauthenticated: true,
                futureExcluded: true,
                consentNonGating: true,
                deliveryFailClosed: true,
            },
        })}`,
    );
    await ownerPool.query('analyze meal.inventory_batches');
    const seedMs = performance.now() - seedStarted;

    const explain = async (statement, values) => {
        const result = await pool.query(`explain (analyze,buffers,format json) ${statement}`, values);
        const report = result.rows[0]['QUERY PLAN'][0];
        const nodeTypes = new Set();
        const collectNodes = (node) => {
            nodeTypes.add(node['Node Type']);
            for (const child of node.Plans ?? []) collectNodes(child);
        };
        collectNodes(report.Plan);
        assert.ok(report['Execution Time'] <= 500, `SQL plan exceeded 500ms: ${report['Execution Time']}ms`);
        return {
            planningMs: Number(report['Planning Time'].toFixed(3)),
            executionMs: Number(report['Execution Time'].toFixed(3)),
            rows: Number(report.Plan['Actual Rows']),
            nodeTypes: [...nodeTypes],
        };
    };
    const largeTenantListPlan = await explain(
        `select b.id,b.name,b.quantity,u.code
         from meal.inventory_batches b join meal.units u on u.id=b.unit_id
         where b.scope_id=$1 and b.kind='ingredient' and b.archived_at is null
         order by b.created_at desc,b.id limit 50 offset 9950`,
        [privateScopeId],
    );
    const largeTenantSearchPlan = await explain(
        `select b.id,b.name,b.quantity,u.code
         from meal.inventory_batches b join meal.units u on u.id=b.unit_id
         where b.scope_id=$1 and b.kind='ingredient' and b.archived_at is null
           and position(lower($2) in lower(b.name))>0
         order by b.created_at desc,b.id limit 50`,
        [privateScopeId, 'tenant item 9999'],
    );
    const largeTenantCountPlan = await explain(
        `select count(*)::integer as total from meal.inventory_batches b
         where b.scope_id=$1 and b.kind='ingredient' and b.archived_at is null`,
        [privateScopeId],
    );

    const largeTenantBatch = await pool.query(
        `select id,quantity::text,version::integer from meal.inventory_batches
         where scope_id=$1 and kind='ingredient' order by created_at limit 1`,
        [privateScopeId],
    );
    assert.equal(largeTenantBatch.rows.length, 1);
    const lockedBatch = largeTenantBatch.rows[0];
    const lockHolder = await pool.connect();
    const lockContender = await pool.connect();
    let lockTimeoutMs;
    let recoveredVersion;
    try {
        await lockHolder.query('begin isolation level serializable');
        await lockHolder.query('select id from meal.inventory_batches where id=$1 for update', [lockedBatch.id]);
        await lockContender.query('begin isolation level serializable');
        await lockContender.query("set local lock_timeout='250ms'");
        const blockedStarted = performance.now();
        await expectPgCode('55P03', () =>
            lockContender.query('update meal.inventory_batches set quantity=quantity+1,version=version+1 where id=$1', [
                lockedBatch.id,
            ]),
        );
        lockTimeoutMs = performance.now() - blockedStarted;
        assert.ok(
            lockTimeoutMs >= 200 && lockTimeoutMs <= 1500,
            `lock timeout resolved in ${lockTimeoutMs.toFixed(2)}ms`,
        );
        await lockContender.query('rollback');
        await lockHolder.query('rollback');

        await lockContender.query('begin isolation level serializable');
        const recovered = await lockContender.query(
            `update meal.inventory_batches set quantity=quantity+1,version=version+1
             where id=$1 returning quantity::text,version::integer`,
            [lockedBatch.id],
        );
        await lockContender.query('commit');
        assert.equal(Number(recovered.rows[0].quantity), Number(lockedBatch.quantity) + 1);
        recoveredVersion = recovered.rows[0].version;
        assert.equal(recoveredVersion, lockedBatch.version + 1);
    } finally {
        await lockHolder.query('rollback').catch(() => undefined);
        await lockContender.query('rollback').catch(() => undefined);
        lockHolder.release();
        lockContender.release();
    }

    const largeTenantProbe = await app.inject({
        method: 'GET',
        url: '/api/v1/inventory?localDate=2026-10-14&limit=50&offset=9950',
        headers: { cookie: headers().cookie },
        remoteAddress: '198.22.0.1',
    });
    assert.equal(largeTenantProbe.statusCode, 200, largeTenantProbe.body);
    assert.ok(largeTenantProbe.json().data.total >= largeTenantRows);
    assert.equal(largeTenantProbe.json().data.items.length, 50);

    const percentile = (values, fraction) => {
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
    };
    let performanceRequestIndex = 0;
    const performanceInject = (options) => {
        const index = performanceRequestIndex++;
        return app.inject({
            ...options,
            remoteAddress: `198.20.${Math.floor(index / 250) + 1}.${(index % 250) + 1}`,
        });
    };
    const latency = async (label, request, expectedStatus = 200) => {
        for (let index = 0; index < 5; index += 1) {
            const warm = await request();
            assert.equal(warm.statusCode, expectedStatus, `${label} warm-up: ${warm.body}`);
        }
        const values = [];
        for (let index = 0; index < 60; index += 1) {
            const started = performance.now();
            const response = await request();
            values.push(performance.now() - started);
            assert.equal(response.statusCode, expectedStatus, `${label}: ${response.body}`);
        }
        const result = {
            p50Ms: Number(percentile(values, 0.5).toFixed(2)),
            p95Ms: Number(percentile(values, 0.95).toFixed(2)),
            p99Ms: Number(percentile(values, 0.99).toFixed(2)),
        };
        assert.ok(result.p95Ms <= 500, `${label} local p95 ${result.p95Ms}ms exceeds 500ms guardrail`);
        assert.ok(result.p99Ms <= 1000, `${label} local p99 ${result.p99Ms}ms exceeds 1000ms guardrail`);
        return result;
    };
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const performanceResults = {
        health: await latency('health', () => performanceInject({ method: 'GET', url: '/health/ready' })),
        entitlement: await latency('entitlement', () =>
            performanceInject({ method: 'GET', url: '/api/v1/entitlements', headers: { cookie: headers().cookie } }),
        ),
        formerPro: await latency('former-pro overview', () =>
            performanceInject({ method: 'GET', url: '/api/v1/pro/overview', headers: { cookie: headers().cookie } }),
        ),
        adminSession: await latency('admin session', () =>
            performanceInject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: adminHeaders() }),
        ),
        largeTenant: {
            rows: largeTenantRows,
            seedMs: Number(seedMs.toFixed(2)),
            listPlan: largeTenantListPlan,
            searchPlan: largeTenantSearchPlan,
            countPlan: largeTenantCountPlan,
            lockTimeoutMs: Number(lockTimeoutMs.toFixed(2)),
            recoveredVersion,
            list: await latency('large tenant inventory', () =>
                performanceInject({
                    method: 'GET',
                    url: '/api/v1/inventory?localDate=2026-10-14&limit=50&offset=9950',
                    headers: { cookie: headers().cookie },
                }),
            ),
            search: await latency('large tenant inventory search', () =>
                performanceInject({
                    method: 'GET',
                    url: '/api/v1/inventory?localDate=2026-10-14&limit=50&offset=0&q=tenant%20item%209999',
                    headers: { cookie: headers().cookie },
                }),
            ),
        },
    };
    const concurrentStarted = performance.now();
    const concurrentResponses = await Promise.all(
        Array.from({ length: 40 }, () =>
            performanceInject({ method: 'GET', url: '/api/v1/entitlements', headers: { cookie: headers().cookie } }),
        ),
    );
    const concurrentMs = performance.now() - concurrentStarted;
    assert.equal(
        concurrentResponses.filter((response) => response.statusCode === 200).length,
        concurrentResponses.length,
    );
    assert.ok(concurrentMs <= 5000, `40-request pool burst took ${concurrentMs.toFixed(2)}ms`);
    globalThis.gc?.();
    const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    assert.ok(heapGrowthBytes <= 96 * 1024 * 1024, `bounded request pack grew heap by ${heapGrowthBytes} bytes`);
    performanceResults.concurrent40 = { wallMs: Number(concurrentMs.toFixed(2)) };
    performanceResults.heap = { growthBytes: heapGrowthBytes };
    let rateLimitedAt = null;
    for (let index = 1; index <= 220; index += 1) {
        const response = await app.inject({
            method: 'GET',
            url: '/api/v1/entitlements',
            headers: { cookie: headers().cookie },
            remoteAddress: '198.21.0.1',
        });
        if (response.statusCode !== 429) {
            assert.equal(response.statusCode, 200, response.body);
            continue;
        }
        assert.equal(errorEnvelopeSchema.safeParse(response.json()).success, true);
        rateLimitedAt = index;
        break;
    }
    assert.ok(rateLimitedAt !== null, 'fixed-IP request burst did not reach the configured rate limit');
    performanceResults.rateLimit = { first429At: rateLimitedAt };

    const document = openApiDocument(app);
    const statuses = new Map();
    let authenticatedReads = 0;
    const getPath = (path) =>
        path.replaceAll(/\{([^}]+)\}/g, (_match, name) => {
            if (name === 'username') return `accept_${suffix}`;
            if (name === 'queue') return 'recipes';
            if (name === 'section') return 'users';
            if (name === 'code') return 'milk';
            if (name === 'token') return 'invalid-token';
            return '00000000-0000-4000-8000-000000000001';
        });
    let authenticatedAdminReads = 0;
    const adminReadStatuses = new Map();
    for (const [path, pathItem] of Object.entries(document.paths)) {
        const operation = pathItem?.get;
        if (!operation || !path.startsWith('/api/v1/admin/')) continue;
        const response = await app.inject({
            method: 'GET',
            url: getPath(path),
            headers: adminHeaders(),
            remoteAddress: `198.19.2.${(authenticatedAdminReads % 250) + 1}`,
        });
        const label = `${operation.operationId} authenticated admin read`;
        assert.notEqual(response.statusCode, 500, `${label}: unhandled error`);
        assert.notEqual(response.statusCode, 501, `${label}: unimplemented route`);
        assert.ok(
            operation.responses[String(response.statusCode)] ?? operation.responses.default,
            `${label}: undocumented HTTP ${response.statusCode}`,
        );
        assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/i, `${label}: request ID`);
        assert.match(String(response.headers['cache-control']), /no-store/i, `${label}: cache policy`);
        if (response.statusCode >= 400)
            assert.equal(
                errorEnvelopeSchema.safeParse(response.json()).success,
                true,
                `${label}: invalid error envelope`,
            );
        adminReadStatuses.set(response.statusCode, (adminReadStatuses.get(response.statusCode) ?? 0) + 1);
        authenticatedAdminReads += 1;
    }
    assert.ok(authenticatedAdminReads >= 20, 'authenticated admin read sweep reached too few operations');
    for (const [path, pathItem] of Object.entries(document.paths)) {
        const operation = pathItem?.get;
        if (!operation) continue;
        const response = await app.inject({
            method: 'GET',
            url: getPath(path),
            headers: { cookie: headers().cookie },
            remoteAddress: `198.19.0.${(authenticatedReads % 250) + 1}`,
        });
        const label = `${operation.operationId} authenticated read`;
        if (response.statusCode === 500 && operation.operationId === 'PersonalizationController_home') {
            try {
                await app.get(PersonalizationService).home(me.json().data.user.id);
            } catch (error) {
                const classification =
                    error && typeof error === 'object' && 'code' in error
                        ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'message' in error ? String(error.message).slice(0, 160) : ''}`
                        : (error?.constructor?.name ?? 'UnknownError');
                throw new Error(`${label}: ${classification}`);
            }
        }
        if (response.statusCode === 500 && operation.operationId === 'AiController_balance') {
            try {
                await app.get(AiService).balance(me.json().data.user.id);
            } catch (error) {
                const classification =
                    error && typeof error === 'object' && 'code' in error
                        ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'message' in error ? String(error.message).slice(0, 160) : ''}`
                        : (error?.constructor?.name ?? 'UnknownError');
                throw new Error(`${label}: ${classification}`);
            }
        }
        if (response.statusCode === 500 && operation.operationId === 'SubscriptionSettingsController_get') {
            try {
                await app.get(SubscriptionSettingsService).get(me.json().data.user.id);
            } catch (error) {
                const classification =
                    error && typeof error === 'object' && 'code' in error
                        ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'message' in error ? String(error.message).slice(0, 160) : ''}`
                        : (error?.constructor?.name ?? 'UnknownError');
                throw new Error(`${label}: ${classification}`);
            }
        }
        if (response.statusCode === 500 && operation.operationId === 'ProOverviewController_get') {
            try {
                await app.get(ProOverviewService).get(me.json().data.user.id);
            } catch (error) {
                const classification =
                    error && typeof error === 'object' && 'code' in error
                        ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'message' in error ? String(error.message).slice(0, 160) : ''}`
                        : (error?.constructor?.name ?? 'UnknownError');
                throw new Error(`${label}: ${classification}`);
            }
        }
        assert.notEqual(response.statusCode, 500, `${label}: unhandled error`);
        assert.notEqual(response.statusCode, 501, `${label}: unimplemented route`);
        assert.ok(
            operation.responses[String(response.statusCode)] ?? operation.responses.default,
            `${label}: undocumented HTTP ${response.statusCode}`,
        );
        assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/i, `${label}: request ID`);
        assert.match(String(response.headers['cache-control']), /no-store/i, `${label}: cache policy`);
        if (response.statusCode >= 400)
            assert.equal(
                errorEnvelopeSchema.safeParse(response.json()).success,
                true,
                `${label}: invalid error envelope`,
            );
        statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
        authenticatedReads += 1;
    }
    assert.equal(authenticatedReads, 132);
    assert.ok((statuses.get(200) ?? 0) >= 10, 'authenticated read sweep reached too few successful projections');

    const adminCsrfResponse = await app.inject({ method: 'GET', url: '/api/v1/admin/auth/csrf' });
    assert.equal(adminCsrfResponse.statusCode, 200, adminCsrfResponse.body);
    const adminCsrfCookie = adminCsrfResponse.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const adminCsrfToken = adminCsrfResponse.json().data.token;

    // Exact live-PostgreSQL acceptance for the generic admin projections and the locally executable
    // admin support/preferences commands. Unlike the boundary sweep below, every request has a valid
    // fixture and is followed by response, persistence, audit and replay/rollback assertions.
    const adminAcceptanceTicketId = randomUUID();
    const adminAcceptanceMessageId = randomUUID();
    const otherAdminSessionId = randomUUID();
    const otherAdminToken = randomBytes(32).toString('base64url');
    const otherModeratorSessionId = randomUUID();
    const otherModeratorToken = randomBytes(32).toString('base64url');
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.support_tickets(
                   id,public_number,category,status,subject,requester_id,assignee_id,thread_id
                 ) values($1,$2,'account','waiting_for_support',$3,$4,null,null)`,
                [adminAcceptanceTicketId, `ADMIN-${suffix}`, 'Admin acceptance support ticket', userId],
            );
            await client.query(
                `insert into meal.support_messages(id,body,internal,ticket_id,author_id)
                 values($1,$2,false,$3,$4)`,
                [adminAcceptanceMessageId, 'Initial admin acceptance message', adminAcceptanceTicketId, userId],
            );
            await client.query(
                `insert into meal.sessions(
                   id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context
                 ) values($1,'staff',$2,now()+interval '1 day',null,now()-interval '1 minute',now(),$3,'admin')`,
                [otherAdminSessionId, createHash('sha256').update(otherAdminToken).digest('hex'), userId],
            );
            await client.query(
                `insert into meal.sessions(
                   id,kind,token_hash,expires_at,revoked_at,authenticated_at,mfa_verified_at,user_id,auth_context
                 ) values($1,'staff',$2,now()+interval '1 day',null,now()-interval '1 minute',now(),$3,'moderator')`,
                [
                    otherModeratorSessionId,
                    createHash('sha256').update(otherModeratorToken).digest('hex'),
                    secondModeratorId,
                ],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const adminAcceptanceHeaders = () => ({
        origin: config.ADMIN_FRONTEND_ORIGIN,
        cookie: `${adminCsrfCookie}; meal_admin=${adminToken}`,
        'x-csrf-token': adminCsrfToken,
        'x-admin-unlock': adminUnlock,
    });
    let adminAcceptanceRequestIndex = 0;
    const adminAcceptanceRequest = (method, url, payload, requestHeaders = adminAcceptanceHeaders()) =>
        app.inject({
            method,
            url,
            headers: requestHeaders,
            remoteAddress: `198.24.0.${++adminAcceptanceRequestIndex}`,
            ...(payload === undefined ? {} : { payload }),
        });
    const adminAuditBefore = await pool.query(
        `select
           count(*) filter(where action='admin.search.read' and target_type='users' and target_id=$1)::int as search_reads,
           count(*) filter(where action='admin.detail.read' and target_type='users' and target_id=$1)::int as detail_reads,
           count(*) filter(where action='admin.notifications.read' and target_id=$1)::int as preference_reads,
           count(*) filter(where action='admin.notifications.updated' and target_id=$1)::int as preference_updates
         from meal.audit_events`,
        [userId],
    );

    const wrongRoleAdminRead = await adminAcceptanceRequest('GET', `/api/v1/admin/users/${userId}`, undefined, {
        cookie: headers().cookie,
        'x-admin-unlock': adminUnlock,
    });
    assert.equal(wrongRoleAdminRead.statusCode, 401, wrongRoleAdminRead.body);
    assert.equal(errorEnvelopeSchema.safeParse(wrongRoleAdminRead.json()).success, true);

    const adminSessions = await adminAcceptanceRequest('GET', '/api/v1/admin/auth/sessions');
    assert.equal(adminSessions.statusCode, 200, adminSessions.body);
    assert.equal(adminSessions.json().data.sessions.length, 2);
    assert.deepEqual(
        new Set(adminSessions.json().data.sessions.map((session) => session.id)),
        new Set([adminSessionId, otherAdminSessionId]),
    );
    assert.equal(adminSessions.json().data.sessions.find((session) => session.id === adminSessionId)?.current, true);
    assert.equal(
        adminSessions.json().data.sessions.find((session) => session.id === otherAdminSessionId)?.current,
        false,
    );
    const noCsrfRevokeOthers = await adminAcceptanceRequest(
        'POST',
        '/api/v1/admin/auth/sessions/revoke-others',
        {},
        {
            origin: config.ADMIN_FRONTEND_ORIGIN,
            cookie: `${adminCsrfCookie}; meal_admin=${adminToken}`,
            'x-admin-unlock': adminUnlock,
        },
    );
    assert.equal(noCsrfRevokeOthers.statusCode, 403, noCsrfRevokeOthers.body);
    assert.equal(errorEnvelopeSchema.safeParse(noCsrfRevokeOthers.json()).success, true);
    assert.equal(
        (await pool.query('select revoked_at is null as active from meal.sessions where id=$1', [otherAdminSessionId]))
            .rows[0].active,
        true,
    );
    const revokedOtherAdminSessions = await adminAcceptanceRequest(
        'POST',
        '/api/v1/admin/auth/sessions/revoke-others',
        {},
    );
    assert.equal(revokedOtherAdminSessions.statusCode, 200, revokedOtherAdminSessions.body);
    assert.deepEqual(revokedOtherAdminSessions.json().data, { revokedCount: 1 });
    const repeatedAdminSessionRevocation = await adminAcceptanceRequest(
        'POST',
        '/api/v1/admin/auth/sessions/revoke-others',
        {},
    );
    assert.equal(repeatedAdminSessionRevocation.statusCode, 200, repeatedAdminSessionRevocation.body);
    assert.deepEqual(repeatedAdminSessionRevocation.json().data, { revokedCount: 0 });
    const adminSessionEffects = await pool.query(
        `select
           (select revoked_at is null from meal.sessions where id=$1) as current_active,
           (select revoked_at is not null from meal.sessions where id=$2) as other_revoked,
           (select count(*)::int from meal.audit_events
             where action='auth.sessions.others_revoked' and actor_id=$3 and target_id=$1) as audits`,
        [adminSessionId, otherAdminSessionId, userId],
    );
    assert.deepEqual(adminSessionEffects.rows[0], { current_active: true, other_revoked: true, audits: 2 });

    const adminSearch = await adminAcceptanceRequest('POST', '/api/v1/admin/users/search', {
        query: `accept_${suffix}`,
        limit: 10,
    });
    assert.equal(adminSearch.statusCode, 200, adminSearch.body);
    assert.equal(adminSearch.json().data.section, 'users');
    assert.equal(adminSearch.json().data.availability, 'available');
    assert.deepEqual(
        adminSearch.json().data.items.map((item) => item.id),
        [userId],
    );

    const adminDetail = await adminAcceptanceRequest('GET', `/api/v1/admin/users/${userId}`);
    assert.equal(adminDetail.statusCode, 200, adminDetail.body);
    assert.equal(adminDetail.json().data.section, 'users');
    assert.equal(adminDetail.json().data.item.id, userId);
    assert.equal(
        adminDetail.json().data.collections.some((collection) => collection.key === 'support'),
        true,
    );

    const adminRelated = await adminAcceptanceRequest('POST', `/api/v1/admin/users/${userId}/related/support/search`, {
        limit: 50,
    });
    assert.equal(adminRelated.statusCode, 200, adminRelated.body);
    assert.equal(
        adminRelated.json().data.items.some((item) => item.id === adminAcceptanceTicketId),
        true,
    );

    const adminPreferences = await adminAcceptanceRequest('GET', '/api/v1/admin/notification-preferences');
    assert.equal(adminPreferences.statusCode, 200, adminPreferences.body);
    assert.deepEqual(adminPreferences.json().data.preferences, { browser: false, mobilePush: false, email: false });
    assert.equal(adminPreferences.json().data.verifiedEmail, email.toLowerCase());

    const noCsrfPreferenceUpdate = await adminAcceptanceRequest(
        'POST',
        '/api/v1/admin/notification-preferences',
        { channel: 'browser', enabled: true },
        {
            origin: config.ADMIN_FRONTEND_ORIGIN,
            cookie: `${adminCsrfCookie}; meal_admin=${adminToken}`,
            'x-admin-unlock': adminUnlock,
        },
    );
    assert.equal(noCsrfPreferenceUpdate.statusCode, 403, noCsrfPreferenceUpdate.body);
    assert.equal(errorEnvelopeSchema.safeParse(noCsrfPreferenceUpdate.json()).success, true);
    assert.equal(
        Number(
            (
                await pool.query(
                    `select count(*)::int as count from meal.notification_preferences
                     where user_id=$1 and category='admin_operations' and channel='browser'`,
                    [userId],
                )
            ).rows[0].count,
        ),
        0,
    );

    const updatedAdminPreferences = await adminAcceptanceRequest('POST', '/api/v1/admin/notification-preferences', {
        channel: 'browser',
        enabled: true,
    });
    assert.equal(updatedAdminPreferences.statusCode, 200, updatedAdminPreferences.body);
    assert.deepEqual(updatedAdminPreferences.json().data.preferences, {
        browser: true,
        mobilePush: false,
        email: false,
    });

    const adminReplyPayload = {
        version: '1',
        idempotencyKey: randomUUID(),
        body: 'Admin acceptance reply',
    };
    const adminReply = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reply`,
        adminReplyPayload,
    );
    assert.equal(adminReply.statusCode, 200, adminReply.body);
    assert.deepEqual(
        {
            ticketId: adminReply.json().data.ticketId,
            version: adminReply.json().data.version,
            status: adminReply.json().data.status,
            assigneeId: adminReply.json().data.assigneeId,
        },
        { ticketId: adminAcceptanceTicketId, version: '2', status: 'waiting_for_user', assigneeId: userId },
    );
    assert.match(adminReply.json().data.messageId, /^[0-9a-f-]{36}$/i);
    const adminReplyReplay = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reply`,
        adminReplyPayload,
    );
    assert.equal(adminReplyReplay.statusCode, 200, adminReplyReplay.body);
    assert.deepEqual(adminReplyReplay.json().data, adminReply.json().data);
    const adminReplyChangedReplay = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reply`,
        { ...adminReplyPayload, body: 'Changed admin acceptance reply' },
    );
    assert.equal(adminReplyChangedReplay.statusCode, 409, adminReplyChangedReplay.body);
    assert.equal(errorEnvelopeSchema.safeParse(adminReplyChangedReplay.json()).success, true);

    const adminMessages = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/messages/search`,
        { limit: 10 },
    );
    assert.equal(adminMessages.statusCode, 200, adminMessages.body);
    assert.equal(adminMessages.json().data.items.length, 2);
    assert.deepEqual(
        new Set(adminMessages.json().data.items.map((item) => item.id)),
        new Set([adminAcceptanceMessageId, adminReply.json().data.messageId]),
    );
    assert.equal(adminMessages.json().data.nextCursor, null);

    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            const closed = await client.query(
                `update meal.support_tickets
                 set status='closed',closed_at=now(),version=version+1 where id=$1 and version=2
                 returning version::int,status`,
                [adminAcceptanceTicketId],
            );
            assert.deepEqual(closed.rows[0], { version: 3, status: 'closed' });
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const adminReopenPayload = { version: '3', idempotencyKey: randomUUID() };
    const adminReopen = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reopen`,
        adminReopenPayload,
    );
    assert.equal(adminReopen.statusCode, 200, adminReopen.body);
    assert.deepEqual(adminReopen.json().data, {
        ticketId: adminAcceptanceTicketId,
        version: '4',
        status: 'waiting_for_support',
        assigneeId: userId,
        messageId: null,
    });
    const adminReopenReplay = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reopen`,
        adminReopenPayload,
    );
    assert.equal(adminReopenReplay.statusCode, 200, adminReopenReplay.body);
    assert.deepEqual(adminReopenReplay.json().data, adminReopen.json().data);
    const adminReopenChangedReplay = await adminAcceptanceRequest(
        'POST',
        `/api/v1/admin/support/${adminAcceptanceTicketId}/reopen`,
        { ...adminReopenPayload, version: '4' },
    );
    assert.equal(adminReopenChangedReplay.statusCode, 409, adminReopenChangedReplay.body);
    assert.equal(errorEnvelopeSchema.safeParse(adminReopenChangedReplay.json()).success, true);

    const adminAcceptanceEffects = await pool.query(
        `select
           t.version::int,t.status,t.assignee_id,t.closed_at is null as reopened,
           (select count(*)::int from meal.support_messages m where m.ticket_id=t.id) as messages,
           (select count(*)::int from meal.support_events e where e.ticket_id=t.id) as events,
           (select count(*)::int from meal.idempotency_records i
             where i.actor_namespace=$2 and i.target_binding=t.id::text) as idempotency,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$1 and a.target_id=t.id and a.action='admin.support.reply') as reply_audits,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$1 and a.target_id=t.id and a.action='admin.support.reopen') as reopen_audits,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$1 and a.target_id=t.id and a.action='admin.support.messages.read') as message_audits,
           (select count(*)::int from meal.notification_preferences p
             where p.user_id=$1 and p.category='admin_operations' and p.channel='browser' and p.enabled) as browser_enabled
         from meal.support_tickets t where t.id=$3`,
        [userId, `user:${userId}`, adminAcceptanceTicketId],
    );
    assert.deepEqual(adminAcceptanceEffects.rows[0], {
        version: 4,
        status: 'waiting_for_support',
        assignee_id: userId,
        reopened: true,
        messages: 2,
        events: 2,
        idempotency: 2,
        reply_audits: 2,
        reopen_audits: 2,
        message_audits: 1,
        browser_enabled: 1,
    });
    const adminAuditAfter = await pool.query(
        `select
           count(*) filter(where action='admin.search.read' and target_type='users' and target_id=$1)::int as search_reads,
           count(*) filter(where action='admin.detail.read' and target_type='users' and target_id=$1)::int as detail_reads,
           count(*) filter(where action='admin.notifications.read' and target_id=$1)::int as preference_reads,
           count(*) filter(where action='admin.notifications.updated' and target_id=$1)::int as preference_updates
         from meal.audit_events`,
        [userId],
    );
    assert.deepEqual(
        {
            search_reads: adminAuditAfter.rows[0].search_reads - adminAuditBefore.rows[0].search_reads,
            detail_reads: adminAuditAfter.rows[0].detail_reads - adminAuditBefore.rows[0].detail_reads,
            preference_reads: adminAuditAfter.rows[0].preference_reads - adminAuditBefore.rows[0].preference_reads,
            preference_updates:
                adminAuditAfter.rows[0].preference_updates - adminAuditBefore.rows[0].preference_updates,
        },
        { search_reads: 1, detail_reads: 2, preference_reads: 1, preference_updates: 1 },
    );
    await runAdminDomainAcceptance({
        app,
        pool,
        ownerPool,
        adminHeaders: adminAcceptanceHeaders,
        adminUserId: userId,
        adminSessionId,
        userId,
        privateScopeId,
        ingredientId: largeTenantIngredientId,
        unitId: largeTenantUnitId,
        suffix,
    });
    const staffAcceptanceHeaders = () => ({
        ...headers(),
        cookie: `${headers().cookie}; meal_staff=${secondModeratorToken}`,
    });
    const staffMe = await adminAcceptanceRequest('GET', '/api/v1/staff/auth/me', undefined, staffAcceptanceHeaders());
    assert.equal(staffMe.statusCode, 200, staffMe.body);
    assert.equal(staffMe.json().data.user.id, secondModeratorId);
    assert.equal(staffMe.json().data.user.context, 'moderator');
    const staffSessions = await adminAcceptanceRequest(
        'GET',
        '/api/v1/staff/auth/sessions',
        undefined,
        staffAcceptanceHeaders(),
    );
    assert.equal(staffSessions.statusCode, 200, staffSessions.body);
    assert.deepEqual(
        new Set(staffSessions.json().data.sessions.map((session) => session.id)),
        new Set([secondModeratorSessionId, otherModeratorSessionId]),
    );
    const noCsrfStaffRevoke = await adminAcceptanceRequest(
        'POST',
        '/api/v1/staff/auth/sessions/revoke-others',
        {},
        { cookie: `${headers().cookie}; meal_staff=${secondModeratorToken}`, origin: config.FRONTEND_ORIGIN },
    );
    assert.equal(noCsrfStaffRevoke.statusCode, 403, noCsrfStaffRevoke.body);
    assert.equal(errorEnvelopeSchema.safeParse(noCsrfStaffRevoke.json()).success, true);
    const staffRevoke = await adminAcceptanceRequest(
        'POST',
        '/api/v1/staff/auth/sessions/revoke-others',
        {},
        staffAcceptanceHeaders(),
    );
    assert.equal(staffRevoke.statusCode, 200, staffRevoke.body);
    assert.deepEqual(staffRevoke.json().data, { revokedCount: 1 });
    const repeatedStaffRevoke = await adminAcceptanceRequest(
        'POST',
        '/api/v1/staff/auth/sessions/revoke-others',
        {},
        staffAcceptanceHeaders(),
    );
    assert.equal(repeatedStaffRevoke.statusCode, 200, repeatedStaffRevoke.body);
    assert.deepEqual(repeatedStaffRevoke.json().data, { revokedCount: 0 });
    const staffSessionEffects = await pool.query(
        `select
           (select revoked_at is null from meal.sessions where id=$1) as current_active,
           (select revoked_at is not null from meal.sessions where id=$2) as other_revoked,
           (select count(*)::int from meal.audit_events
             where action='auth.sessions.others_revoked' and actor_id=$3 and target_id=$1) as audits`,
        [secondModeratorSessionId, otherModeratorSessionId, secondModeratorId],
    );
    assert.deepEqual(staffSessionEffects.rows[0], { current_active: true, other_revoked: true, audits: 2 });
    const staffLogout = await adminAcceptanceRequest('POST', '/api/v1/staff/auth/logout', {}, staffAcceptanceHeaders());
    assert.equal(staffLogout.statusCode, 200, staffLogout.body);
    assert.deepEqual(staffLogout.json().data, { loggedOut: true });
    assert.equal(
        (
            await pool.query('select revoked_at is not null as revoked from meal.sessions where id=$1', [
                secondModeratorSessionId,
            ])
        ).rows[0].revoked,
        true,
    );
    const adminP0Evidence = {
        schema: 'admin-live-happy-path-v1',
        operationIds: [
            'AdminReadController_search',
            'AdminReadController_detail',
            'AdminReadController_related',
            'AdminActionsController_preferences',
            'AdminActionsController_updatePreferences',
            'AdminActionsController_reply',
            'AdminActionsController_messages',
            'AdminActionsController_reopen',
            'AdminAuthController_sessions',
            'AdminAuthController_revokeOthers',
            'StaffAuthController_me',
            'StaffAuthController_sessions',
            'StaffAuthController_revokeOthers',
            'StaffAuthController_logout',
        ],
        assertions: {
            validFixtures: true,
            responseContracts: true,
            databaseEffects: true,
            auditEffects: true,
            idempotentReplay: true,
            changedReplayRollback: true,
            csrfFailClosed: true,
            roleFailClosed: true,
            sessionIsolation: true,
            staffSessionLifecycle: true,
        },
    };
    console.log(`ACCEPTANCE_EVIDENCE ${JSON.stringify({ ...inventoryEvidence, admin: adminP0Evidence })}`);
    const mutationStatuses = new Map();
    let authenticatedMutations = 0;
    for (const [path, pathItem] of Object.entries(document.paths)) {
        for (const method of ['post', 'put', 'patch', 'delete']) {
            const operation = pathItem?.[method];
            if (
                !operation ||
                (method === 'post' && ['/api/v1/auth/logout', '/api/v1/admin/auth/logout'].includes(path))
            )
                continue;
            const admin = path.startsWith('/api/v1/admin/');
            const response = await app.inject({
                method: method.toUpperCase(),
                url: getPath(path),
                headers: admin
                    ? {
                          origin: config.ADMIN_FRONTEND_ORIGIN,
                          cookie: `${adminCsrfCookie}; meal_admin=${adminToken}`,
                          'x-csrf-token': adminCsrfToken,
                          'x-admin-unlock': adminUnlock,
                      }
                    : headers(),
                remoteAddress: `198.19.1.${(authenticatedMutations % 250) + 1}`,
                payload: {},
            });
            const label = `${operation.operationId} authenticated mutation boundary`;
            assert.notEqual(response.statusCode, 500, `${label}: unhandled error`);
            assert.notEqual(response.statusCode, 501, `${label}: unimplemented route`);
            assert.ok(
                operation.responses[String(response.statusCode)] ?? operation.responses.default,
                `${label}: undocumented HTTP ${response.statusCode}`,
            );
            assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/i, `${label}: request ID`);
            assert.match(String(response.headers['cache-control']), /no-store/i, `${label}: cache policy`);
            if (response.statusCode >= 400)
                assert.equal(
                    errorEnvelopeSchema.safeParse(response.json()).success,
                    true,
                    `${label}: invalid error envelope`,
                );
            mutationStatuses.set(response.statusCode, (mutationStatuses.get(response.statusCode) ?? 0) + 1);
            authenticatedMutations += 1;
        }
    }
    assert.equal(authenticatedMutations, 213);

    const adminLogout = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/logout',
        headers: {
            origin: config.ADMIN_FRONTEND_ORIGIN,
            cookie: `${adminCsrfCookie}; meal_admin=${adminToken}`,
            'x-csrf-token': adminCsrfToken,
            'x-admin-unlock': adminUnlock,
        },
        payload: {},
    });
    assert.equal(adminLogout.statusCode, 200, adminLogout.body);
    assert.equal(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: adminHeaders() })).statusCode,
        401,
    );

    // Complete auth challenge/TOTP acceptance after the manually seeded sessions have served the
    // domain scenarios above. Fresh enrollment makes the TOTP secret available only to this process;
    // recovery codes then exercise unlock and critical confirmation without reusing a TOTP step.
    {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `update meal.mfa_factors set revoked_at=now(),version=version+1
                 where user_id=any($1::uuid[]) and revoked_at is null`,
                [[userId, secondModeratorId]],
            );
            await client.query(
                `insert into meal.password_credentials(id,password_hash,changed_at,user_id)
                 select $1,password_hash,now(),$2 from meal.password_credentials where user_id=$3`,
                [randomUUID(), secondModeratorId, userId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const adminAuthHeaders = (cookie, proof) => ({
        origin: config.ADMIN_FRONTEND_ORIGIN,
        cookie: `${adminCsrfCookie}${cookie ? `; meal_admin=${cookie}` : ''}`,
        'x-csrf-token': adminCsrfToken,
        ...(proof ? { 'x-admin-unlock': proof } : {}),
    });
    const adminLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: adminAuthHeaders(),
        remoteAddress: '198.25.0.1',
        payload: { login: `accept_${suffix}`, password: 'AcceptancePassword1!', context: 'admin' },
    });
    assert.equal(adminLogin.statusCode, 200, adminLogin.body);
    assert.equal(adminLogin.json().data.status, 'mfa_required');
    assert.match(adminLogin.json().data.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.match(adminLogin.json().data.enrollment.secret, /^[A-Z2-7]+$/);
    const adminTotp = generateSync({
        secret: adminLogin.json().data.enrollment.secret,
        period: 30,
        digits: 6,
        epoch: Math.floor(Date.now() / 1000),
    });
    const adminVerify = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/mfa/verify',
        headers: adminAuthHeaders(),
        remoteAddress: '198.25.0.2',
        payload: { challenge: adminLogin.json().data.challenge, code: adminTotp, method: 'totp' },
    });
    assert.equal(adminVerify.statusCode, 200, adminVerify.body);
    assert.equal(adminVerify.json().data.user.id, userId);
    assert.equal(adminVerify.json().data.user.context, 'admin');
    assert.equal(adminVerify.json().data.recoveryCodes.length, 10);
    const issuedAdminCookie = adminVerify.cookies.find((cookie) => cookie.name === 'meal_admin')?.value;
    assert.match(issuedAdminCookie ?? '', /^[A-Za-z0-9_-]{43}$/);
    const issuedAdminSessionId = adminVerify.json().data.user.sessionId;
    const lockedAdminStatus = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/auth/status',
        headers: adminAuthHeaders(issuedAdminCookie),
    });
    assert.equal(lockedAdminStatus.statusCode, 200, lockedAdminStatus.body);
    assert.equal(lockedAdminStatus.json().data.status, 'locked');
    assert.equal(lockedAdminStatus.json().data.criticalUntil, null);
    const initialAdminProof = adminVerify.json().data.unlockToken;
    const unlockedAdminStatus = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/auth/status',
        headers: adminAuthHeaders(issuedAdminCookie, initialAdminProof),
    });
    assert.equal(unlockedAdminStatus.statusCode, 200, unlockedAdminStatus.body);
    assert.equal(unlockedAdminStatus.json().data.status, 'unlocked');
    const adminUnlockResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/unlock',
        headers: adminAuthHeaders(issuedAdminCookie),
        remoteAddress: '198.25.0.3',
        payload: { code: adminVerify.json().data.recoveryCodes[0], method: 'recovery' },
    });
    assert.equal(adminUnlockResponse.statusCode, 200, adminUnlockResponse.body);
    assert.match(adminUnlockResponse.json().data.unlockToken, /^[A-Za-z0-9_-]{43}$/);
    const adminConfirmResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/critical-confirm',
        headers: adminAuthHeaders(issuedAdminCookie, adminUnlockResponse.json().data.unlockToken),
        remoteAddress: '198.25.0.4',
        payload: { code: adminVerify.json().data.recoveryCodes[1], method: 'recovery' },
    });
    assert.equal(adminConfirmResponse.statusCode, 200, adminConfirmResponse.body);
    assert.ok(new Date(adminConfirmResponse.json().data.criticalUntil).getTime() > Date.now());
    const adminAuthEffects = await pool.query(
        `select
           s.revoked_at is null as active,s.mfa_verified_at is not null as mfa_verified,
           s.admin_critical_until > now() as critical,
           (select count(*)::int from meal.admin_session_unlocks u where u.session_id=s.id) as unlocks,
           (select count(*)::int from meal.auth_challenges c
             where c.user_id=$2 and c.purpose='admin_login' and c.used_at is not null) as used_challenges,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$2 and a.action='admin.unlock.accepted' and a.target_id=s.id) as unlock_audits,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$2 and a.action='admin.critical.accepted' and a.target_id=s.id) as critical_audits
         from meal.sessions s where s.id=$1`,
        [issuedAdminSessionId, userId],
    );
    assert.deepEqual(adminAuthEffects.rows[0], {
        active: true,
        mfa_verified: true,
        critical: true,
        unlocks: 2,
        used_challenges: 1,
        unlock_audits: 1,
        critical_audits: 1,
    });
    const criticalAdminHeaders = adminAuthHeaders(issuedAdminCookie, adminUnlockResponse.json().data.unlockToken);
    const freeAiBefore = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}`,
        headers: criticalAdminHeaders,
    });
    assert.equal(freeAiBefore.statusCode, 200, freeAiBefore.body);
    assert.equal(freeAiBefore.json().data.user.id, secondModeratorId);
    assert.equal(freeAiBefore.json().data.total, 0);
    assert.equal(freeAiBefore.json().data.available, 0);
    assert.deepEqual(freeAiBefore.json().data.buckets, []);
    const freeAiGrantPayload = {
        expectedUserVersion: freeAiBefore.json().data.user.version,
        actions: 125,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        reason: 'Acceptance quota grant',
        idempotencyKey: randomUUID(),
        confirmed: true,
    };
    const freeAiNoCsrf = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}/grants`,
        headers: {
            origin: config.ADMIN_FRONTEND_ORIGIN,
            cookie: `${adminCsrfCookie}; meal_admin=${issuedAdminCookie}`,
            'x-admin-unlock': adminUnlockResponse.json().data.unlockToken,
        },
        payload: freeAiGrantPayload,
    });
    assert.equal(freeAiNoCsrf.statusCode, 403, freeAiNoCsrf.body);
    assert.equal(errorEnvelopeSchema.safeParse(freeAiNoCsrf.json()).success, true);
    const freeAiGrant = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}/grants`,
        headers: criticalAdminHeaders,
        payload: freeAiGrantPayload,
    });
    assert.equal(freeAiGrant.statusCode, 200, freeAiGrant.body);
    assert.equal(freeAiGrant.json().data.granted, 125);
    assert.equal(freeAiGrant.json().data.balance, 125);
    assert.equal(freeAiGrant.json().data.expiresAt, freeAiGrantPayload.expiresAt);
    const freeAiReplay = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}/grants`,
        headers: criticalAdminHeaders,
        payload: freeAiGrantPayload,
    });
    assert.equal(freeAiReplay.statusCode, 200, freeAiReplay.body);
    assert.deepEqual(freeAiReplay.json().data, freeAiGrant.json().data);
    const freeAiChangedReplay = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}/grants`,
        headers: criticalAdminHeaders,
        payload: { ...freeAiGrantPayload, actions: 126 },
    });
    assert.equal(freeAiChangedReplay.statusCode, 409, freeAiChangedReplay.body);
    assert.equal(errorEnvelopeSchema.safeParse(freeAiChangedReplay.json()).success, true);
    const freeAiStale = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}/grants`,
        headers: criticalAdminHeaders,
        payload: { ...freeAiGrantPayload, expectedUserVersion: '999', idempotencyKey: randomUUID() },
    });
    assert.equal(freeAiStale.statusCode, 409, freeAiStale.body);
    const freeAiAfter = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/free-ai/users/${secondModeratorId}`,
        headers: criticalAdminHeaders,
    });
    assert.equal(freeAiAfter.statusCode, 200, freeAiAfter.body);
    assert.equal(freeAiAfter.json().data.total, 125);
    assert.equal(freeAiAfter.json().data.reserved, 0);
    assert.equal(freeAiAfter.json().data.available, 125);
    assert.equal(freeAiAfter.json().data.buckets.length, 1);
    assert.equal(freeAiAfter.json().data.buckets[0].id, freeAiGrant.json().data.bucketId);
    const freeAiEffects = await pool.query(
        `select
           (select count(*)::int from meal.ai_buckets where id=$1 and user_id=$2
             and kind='trial' and granted=125 and balance_projection=125 and reserved_projection=0) as buckets,
           (select count(*)::int from meal.ai_ledger where bucket_id=$1 and kind='grant'
             and delta=125 and reserved_delta=0) as ledger,
           (select count(*)::int from meal.idempotency_records where operation='admin.free-ai.grant'
             and actor_namespace=$3 and target_binding=$2::text and key=$4) as idempotency,
           (select count(*)::int from meal.audit_events where action='admin.free-ai.granted'
             and actor_id=$5 and target_id=$2 and reason=$6) as audits`,
        [
            freeAiGrant.json().data.bucketId,
            secondModeratorId,
            `admin:${userId}`,
            freeAiGrantPayload.idempotencyKey,
            userId,
            freeAiGrantPayload.reason,
        ],
    );
    assert.deepEqual(freeAiEffects.rows[0], { buckets: 1, ledger: 1, idempotency: 1, audits: 1 });
    console.log(
        `ADMIN_DOMAIN_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'admin-free-ai-live-v1',
            operationIds: ['AdminFreeAiController_view', 'AdminFreeAiController_grant'],
            assertions: {
                readback: true,
                databaseEffects: true,
                audit: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                staleVersionRollback: true,
                csrfFailClosed: true,
                criticalConfirmation: true,
            },
        })}`,
    );

    const adminBillingRequest = (method, section, id, payload, requestHeaders = criticalAdminHeaders) =>
        app.inject({
            method,
            url: `/api/v1/admin/billing/${section}/${id}`,
            headers: requestHeaders,
            remoteAddress: '198.18.20.1',
            ...(payload === undefined ? {} : { payload }),
        });
    const billingInitial = await adminBillingRequest('GET', 'users', userId);
    assert.equal(billingInitial.statusCode, 200, billingInitial.body);
    assert.equal(billingInitial.json().data.ownerId, userId);
    assert.equal(billingInitial.json().data.plan, 'free');
    assert.equal(billingInitial.json().data.status, 'inactive');
    assert.equal(billingInitial.json().data.payment, null);
    const billingUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const billingGrantKey = randomUUID();
    const billingGrantPayload = {
        version: billingInitial.json().data.version,
        idempotencyKey: billingGrantKey,
        action: 'grant',
        plan: 'plus',
        until: billingUntil,
        targetId: null,
        amountMinor: null,
        effect: 'preserve',
        reason: 'Acceptance Plus gift',
        confirmed: true,
        accessConfirmed: false,
    };
    const setAdminCriticalUntil = async (value) => {
        const client = await pool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(`update meal.sessions set admin_critical_until=$2 where id=$1`, [
                issuedAdminSessionId,
                value,
            ]);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    };
    await setAdminCriticalUntil(null);
    const billingBeforeCriticalFailure = await pool.query(
        `select
           (select count(*)::int from meal.subscriptions where owner_id=$1) subscriptions,
           (select count(*)::int from meal.subscription_changes where actor_id=$2 and kind='grant') changes,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and operation like 'admin.billing.%') idempotency`,
        [userId, userId, `admin:${userId}`],
    );
    const billingCriticalFailure = await adminBillingRequest(
        'POST',
        'users',
        userId,
        billingGrantPayload,
        criticalAdminHeaders,
    );
    assert.equal(billingCriticalFailure.statusCode, 403, billingCriticalFailure.body);
    assert.equal(billingCriticalFailure.json().error.code, 'ADMIN_CONFIRMATION_REQUIRED');
    await setAdminCriticalUntil(new Date(Date.now() + 5 * 60_000));
    const billingAfterCriticalFailure = await pool.query(
        `select
           (select count(*)::int from meal.subscriptions where owner_id=$1) subscriptions,
           (select count(*)::int from meal.subscription_changes where actor_id=$2 and kind='grant') changes,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and operation like 'admin.billing.%') idempotency`,
        [userId, userId, `admin:${userId}`],
    );
    assert.deepEqual(billingAfterCriticalFailure.rows[0], billingBeforeCriticalFailure.rows[0]);

    const billingGrant = await adminBillingRequest('POST', 'users', userId, billingGrantPayload);
    assert.equal(billingGrant.statusCode, 200, billingGrant.body);
    assert.equal(billingGrant.json().data.status, 'succeeded');
    const billingGrantReplay = await adminBillingRequest('POST', 'users', userId, billingGrantPayload);
    assert.equal(billingGrantReplay.statusCode, 200, billingGrantReplay.body);
    assert.deepEqual(billingGrantReplay.json().data, billingGrant.json().data);
    assert.equal(
        (
            await adminBillingRequest('POST', 'users', userId, {
                ...billingGrantPayload,
                until: new Date(Date.now() + 31 * 86_400_000).toISOString(),
            })
        ).statusCode,
        409,
    );
    assert.equal(
        (
            await adminBillingRequest('POST', 'users', userId, {
                ...billingGrantPayload,
                version: '999',
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        409,
    );
    const billingAfterGrant = await adminBillingRequest('GET', 'users', userId);
    assert.equal(billingAfterGrant.statusCode, 200, billingAfterGrant.body);
    assert.equal(billingAfterGrant.json().data.plan, 'plus');
    assert.equal(billingAfterGrant.json().data.status, 'active');
    assert.equal(billingAfterGrant.json().data.periods.length, 1);
    assert.equal(billingAfterGrant.json().data.periods[0].source, 'gift');
    assert.equal(billingAfterGrant.json().data.periods[0].revoked, false);
    assert.equal((await entitlement('plus', 'gift', '198.18.10.1')).capabilities.family, true);
    const billingSubscriptionId = (
        await pool.query(
            `select s.id from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
             where s.owner_id=$1 and p.code='plus' order by s.created_at desc,s.id desc limit 1`,
            [userId],
        )
    ).rows[0].id;

    const billingSubscriptionView = await adminBillingRequest('GET', 'subscriptions', billingSubscriptionId);
    assert.equal(billingSubscriptionView.statusCode, 200, billingSubscriptionView.body);
    const firstBillingPeriod = billingSubscriptionView.json().data.periods[0];
    const extendedUntil = new Date(new Date(firstBillingPeriod.endsAt).getTime() + 30 * 86_400_000).toISOString();
    const billingExtendPayload = {
        ...billingGrantPayload,
        version: billingSubscriptionView.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'extend',
        until: extendedUntil,
        reason: 'Acceptance Plus extension',
    };
    const billingExtend = await adminBillingRequest(
        'POST',
        'subscriptions',
        billingSubscriptionId,
        billingExtendPayload,
    );
    assert.equal(billingExtend.statusCode, 200, billingExtend.body);
    const billingAfterExtend = await adminBillingRequest('GET', 'subscriptions', billingSubscriptionId);
    assert.equal(billingAfterExtend.statusCode, 200, billingAfterExtend.body);
    assert.equal(billingAfterExtend.json().data.periods.length, 2);
    assert.equal(billingAfterExtend.json().data.periods[1].startsAt, firstBillingPeriod.endsAt);
    assert.equal(billingAfterExtend.json().data.periods[1].endsAt, extendedUntil);

    const billingFreeze = await adminBillingRequest('POST', 'subscriptions', billingSubscriptionId, {
        ...billingGrantPayload,
        version: billingAfterExtend.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'freeze',
        until: null,
        reason: 'Acceptance freeze',
    });
    assert.equal(billingFreeze.statusCode, 200, billingFreeze.body);
    const billingFrozenView = await adminBillingRequest('GET', 'subscriptions', billingSubscriptionId);
    assert.equal(billingFrozenView.statusCode, 200, billingFrozenView.body);
    assert.equal(billingFrozenView.json().data.status, 'frozen');
    assert.equal(billingFrozenView.json().data.frozen, true);
    assert.equal((await entitlement('free', 'none', '198.18.10.2')).capabilities.family, false);

    const billingUnfreeze = await adminBillingRequest('POST', 'subscriptions', billingSubscriptionId, {
        ...billingGrantPayload,
        version: billingFrozenView.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'unfreeze',
        until: null,
        reason: 'Acceptance unfreeze',
    });
    assert.equal(billingUnfreeze.statusCode, 200, billingUnfreeze.body);
    const billingUnfrozenView = await adminBillingRequest('GET', 'subscriptions', billingSubscriptionId);
    assert.equal(billingUnfrozenView.statusCode, 200, billingUnfrozenView.body);
    assert.equal(billingUnfrozenView.json().data.status, 'active');
    assert.equal(billingUnfrozenView.json().data.frozen, false);
    assert.equal((await entitlement('plus', 'gift', '198.18.10.3')).capabilities.family, true);

    const extensionPeriod = billingUnfrozenView
        .json()
        .data.periods.find((period) => period.id !== firstBillingPeriod.id);
    assert.ok(extensionPeriod);
    const billingRevokePayload = {
        ...billingGrantPayload,
        version: billingUnfrozenView.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'revokeGift',
        until: null,
        targetId: extensionPeriod.id,
        reason: 'Acceptance revoke extension',
    };
    const billingRevoke = await adminBillingRequest(
        'POST',
        'subscriptions',
        billingSubscriptionId,
        billingRevokePayload,
    );
    assert.equal(billingRevoke.statusCode, 200, billingRevoke.body);
    const billingRevokeReplay = await adminBillingRequest(
        'POST',
        'subscriptions',
        billingSubscriptionId,
        billingRevokePayload,
    );
    assert.equal(billingRevokeReplay.statusCode, 200, billingRevokeReplay.body);
    assert.deepEqual(billingRevokeReplay.json().data, billingRevoke.json().data);
    const billingAfterRevoke = await adminBillingRequest('GET', 'subscriptions', billingSubscriptionId);
    assert.equal(billingAfterRevoke.statusCode, 200, billingAfterRevoke.body);
    assert.equal(
        billingAfterRevoke.json().data.periods.find((period) => period.id === extensionPeriod.id).revoked,
        true,
    );
    assert.equal(billingAfterRevoke.json().data.status, 'active');
    assert.equal(
        (
            await adminBillingRequest('POST', 'subscriptions', billingSubscriptionId, {
                ...billingRevokePayload,
                version: billingAfterRevoke.json().data.version,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        409,
    );

    const concurrentBillingView = await adminBillingRequest('GET', 'users', secondModeratorId);
    assert.equal(concurrentBillingView.statusCode, 200, concurrentBillingView.body);
    const concurrentBillingBase = {
        ...billingGrantPayload,
        version: concurrentBillingView.json().data.version,
        until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reason: 'Acceptance concurrent gift',
    };
    const concurrentBillingResults = await Promise.all([
        adminBillingRequest('POST', 'users', secondModeratorId, {
            ...concurrentBillingBase,
            idempotencyKey: randomUUID(),
        }),
        adminBillingRequest('POST', 'users', secondModeratorId, {
            ...concurrentBillingBase,
            idempotencyKey: randomUUID(),
        }),
    ]);
    assert.deepEqual(concurrentBillingResults.map((response) => response.statusCode).sort(), [200, 409]);
    const proGiftUserId = randomUUID();
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.users(id,login,display_name,email_normalized,status,archived_at,email_verified_at,is_test_account)
                 values($1,$2,'Получатель Pro-подарка',$3,'active',null,now(),true)`,
                [proGiftUserId, `pro_gift_${suffix}`, `pro-gift-${suffix}@example.test`],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const proGiftInitial = await adminBillingRequest('GET', 'users', proGiftUserId);
    assert.equal(proGiftInitial.statusCode, 200, proGiftInitial.body);
    const proGift = await adminBillingRequest('POST', 'users', proGiftUserId, {
        ...billingGrantPayload,
        version: proGiftInitial.json().data.version,
        idempotencyKey: randomUUID(),
        plan: 'pro',
        until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        reason: 'Acceptance provider-independent Pro gift',
    });
    assert.equal(proGift.statusCode, 200, proGift.body);
    const proGiftView = await adminBillingRequest('GET', 'users', proGiftUserId);
    assert.equal(proGiftView.statusCode, 200, proGiftView.body);
    assert.equal(proGiftView.json().data.plan, 'pro');
    assert.equal(proGiftView.json().data.status, 'active');
    assert.equal(proGiftView.json().data.payment, null);
    const proGiftSubscriptionId = (
        await pool.query(
            `select s.id from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
             where s.owner_id=$1 and p.code='pro' order by s.created_at desc,s.id desc limit 1`,
            [proGiftUserId],
        )
    ).rows[0].id;

    const proFreeAiBefore = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/free-ai/users/${proGiftUserId}`,
        headers: criticalAdminHeaders,
    });
    assert.equal(proFreeAiBefore.statusCode, 200, proFreeAiBefore.body);
    const proFreeAiGrant = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/free-ai/users/${proGiftUserId}/grants`,
        headers: criticalAdminHeaders,
        payload: {
            expectedUserVersion: proFreeAiBefore.json().data.user.version,
            actions: 25,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            reason: 'Acceptance compensation for active Pro',
            idempotencyKey: randomUUID(),
            confirmed: true,
        },
    });
    assert.equal(proFreeAiGrant.statusCode, 200, proFreeAiGrant.body);
    assert.equal(proFreeAiGrant.json().data.balance, 25);

    const proSubscriptionView = await adminBillingRequest('GET', 'subscriptions', proGiftSubscriptionId);
    assert.equal(proSubscriptionView.statusCode, 200, proSubscriptionView.body);
    const proFreeze = await adminBillingRequest('POST', 'subscriptions', proGiftSubscriptionId, {
        ...billingGrantPayload,
        version: proSubscriptionView.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'freeze',
        plan: 'pro',
        until: null,
        reason: 'Acceptance Pro freeze',
    });
    assert.equal(proFreeze.statusCode, 200, proFreeze.body);
    const proFrozenView = await adminBillingRequest('GET', 'subscriptions', proGiftSubscriptionId);
    assert.equal(proFrozenView.statusCode, 200, proFrozenView.body);
    assert.equal(proFrozenView.json().data.status, 'frozen');
    const proUnfreeze = await adminBillingRequest('POST', 'subscriptions', proGiftSubscriptionId, {
        ...billingGrantPayload,
        version: proFrozenView.json().data.version,
        idempotencyKey: randomUUID(),
        action: 'unfreeze',
        plan: 'pro',
        until: null,
        reason: 'Acceptance Pro unfreeze',
    });
    assert.equal(proUnfreeze.statusCode, 200, proUnfreeze.body);
    const proUnfrozenView = await adminBillingRequest('GET', 'subscriptions', proGiftSubscriptionId);
    assert.equal(proUnfrozenView.statusCode, 200, proUnfrozenView.body);
    assert.equal(proUnfrozenView.json().data.status, 'active');
    assert.equal(proUnfrozenView.json().data.quota, 25);

    const adminBillingEffects = await pool.query(
        `select
           (select count(*)::int from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
             where s.owner_id=$1 and p.code='plus') target_subscriptions,
           (select count(*)::int from meal.subscription_periods where subscription_id=$2) target_periods,
           (select count(*)::int from meal.subscription_changes where subscription_id=$2 and status='applied') target_changes,
           (select count(*)::int from meal.idempotency_records where actor_namespace=$3 and operation like 'admin.billing.%'
             and target_binding in($1::text,$2::text)) target_idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$4 and action like 'admin.billing.%'
             and target_id=$2) target_audits,
           (select count(*)::int from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
             where s.owner_id=$5 and p.code='plus') concurrent_subscriptions,
           (select count(*)::int from meal.subscriptions s join meal.billing_products p on p.id=s.product_id
             where s.owner_id=$6 and p.code='pro' and s.status='active') pro_gift_subscriptions,
           (select count(*)::int from meal.ai_buckets where user_id=$6 and granted=25) pro_compensation_buckets`,
        [userId, billingSubscriptionId, `admin:${userId}`, userId, secondModeratorId, proGiftUserId],
    );
    assert.deepEqual(adminBillingEffects.rows[0], {
        target_subscriptions: 2,
        target_periods: 2,
        target_changes: 5,
        target_idempotency: 5,
        target_audits: 10,
        concurrent_subscriptions: 1,
        pro_gift_subscriptions: 1,
        pro_compensation_buckets: 1,
    });
    console.log(
        `ADMIN_BILLING_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'admin-billing-live-v1',
            operationIds: ['AdminBillingController_view', 'AdminBillingController_command'],
            effects: adminBillingEffects.rows[0],
            assertions: {
                criticalGate: true,
                grantExtendFreezeUnfreezeRevoke: true,
                entitlementReadback: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                staleVersionRollback: true,
                concurrentSingleWinner: true,
                providerIndependentProGift: true,
                providerIndependentProFreeze: true,
                compensationQuotaAllTariffs: true,
                databaseEffects: true,
            },
        })}`,
    );

    const operationsRetryJobId = randomUUID();
    const operationsCancelJobId = randomUUID();
    const operationsConcurrentJobId = randomUUID();
    const operationsIncidentId = randomUUID();
    const operationsConcurrentIncidentId = randomUUID();
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `insert into meal.background_jobs(id,kind,status,run_at,dedup_key,payload_minimized)
                 values
                   ($1,'recipe_import','failed',now(),$2,'{}'::jsonb),
                   ($3,'recipe_import','pending',now(),$4,'{}'::jsonb),
                   ($5,'recipe_import','dead_letter',now(),$6,'{}'::jsonb)`,
                [
                    operationsRetryJobId,
                    `acceptance-operations-retry-${suffix}`,
                    operationsCancelJobId,
                    `acceptance-operations-cancel-${suffix}`,
                    operationsConcurrentJobId,
                    `acceptance-operations-concurrent-${suffix}`,
                ],
            );
            await client.query(
                `insert into meal.admin_error_events
                   (id,occurred_at,source,severity,environment,app_version,code,message,version)
                 values
                   ($1,now(),'backend','error','test',$2,'acceptance.operations.lifecycle','Sanitized lifecycle acceptance incident',1),
                   ($3,now(),'worker','critical','test',$2,'acceptance.operations.concurrent','Sanitized concurrent acceptance incident',1)`,
                [operationsIncidentId, config.APP_VERSION, operationsConcurrentIncidentId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    await setAdminCriticalUntil(null);
    assert.equal(
        (
            await pool.query('select admin_critical_until is null as not_critical from meal.sessions where id=$1', [
                issuedAdminSessionId,
            ])
        ).rows[0].not_critical,
        true,
    );
    let adminOperationsRequestIndex = 0;
    const adminOperationsRequest = (route, payload, requestHeaders = criticalAdminHeaders) =>
        app.inject({
            method: 'POST',
            url: `/api/v1/admin/operations-workspace/${route}`,
            headers: requestHeaders,
            remoteAddress: `198.18.21.${++adminOperationsRequestIndex}`,
            payload,
        });
    const operationsInput = ({
        section,
        id,
        action,
        operation,
        expectedVersion = '1',
        reason,
        ignoreUntil = null,
        idempotencyKey = randomUUID(),
    }) => ({ section, id, action, operation, reason, ignoreUntil, expectedVersion, idempotencyKey });
    const retryInspectPayload = operationsInput({
        section: 'operations',
        id: operationsRetryJobId,
        action: 'inspect',
        operation: 'retry',
        reason: 'Acceptance inspect failed import',
    });
    const operationsUnauthenticated = await adminOperationsRequest('inspect', retryInspectPayload, adminAuthHeaders());
    assert.equal(operationsUnauthenticated.statusCode, 401, operationsUnauthenticated.body);
    assert.equal(errorEnvelopeSchema.safeParse(operationsUnauthenticated.json()).success, true);
    const operationsLocked = await adminOperationsRequest(
        'inspect',
        retryInspectPayload,
        adminAuthHeaders(issuedAdminCookie),
    );
    assert.equal(operationsLocked.statusCode, 403, operationsLocked.body);
    assert.equal(operationsLocked.json().error.code, 'ADMIN_LOCKED');
    const operationsNoCsrf = await adminOperationsRequest('inspect', retryInspectPayload, {
        origin: config.ADMIN_FRONTEND_ORIGIN,
        cookie: `${adminCsrfCookie}; meal_admin=${issuedAdminCookie}`,
        'x-admin-unlock': adminUnlockResponse.json().data.unlockToken,
    });
    assert.equal(operationsNoCsrf.statusCode, 403, operationsNoCsrf.body);
    assert.equal(errorEnvelopeSchema.safeParse(operationsNoCsrf.json()).success, true);
    const operationsRouteMismatch = await adminOperationsRequest('preview', retryInspectPayload);
    assert.equal(operationsRouteMismatch.statusCode, 400, operationsRouteMismatch.body);
    assert.equal(errorEnvelopeSchema.safeParse(operationsRouteMismatch.json()).success, true);

    const retryInspect = await adminOperationsRequest('inspect', retryInspectPayload);
    assert.equal(retryInspect.statusCode, 200, retryInspect.body);
    assert.equal(retryInspect.json().data.status, 'failed');
    assert.equal(retryInspect.json().data.version, '1');
    assert.equal(retryInspect.json().data.allowed.find((item) => item.operation === 'retry')?.enabled, true);
    const retryPreviewPayload = { ...retryInspectPayload, action: 'preview', idempotencyKey: randomUUID() };
    const retryPreview = await adminOperationsRequest('preview', retryPreviewPayload);
    assert.equal(retryPreview.statusCode, 200, retryPreview.body);
    assert.deepEqual(retryPreview.json().data.preview, {
        summary: 'Импорт будет повторно поставлен в очередь. Результат импорта не гарантируется.',
        critical: false,
    });
    const retryExecutePayload = { ...retryInspectPayload, action: 'execute', idempotencyKey: randomUUID() };
    const retryExecute = await adminOperationsRequest('execute', retryExecutePayload);
    assert.equal(retryExecute.statusCode, 200, retryExecute.body);
    assert.equal(retryExecute.json().data.status, 'queued');
    assert.equal(retryExecute.json().data.version, '2');
    const retryReplay = await adminOperationsRequest('execute', retryExecutePayload);
    assert.equal(retryReplay.statusCode, 200, retryReplay.body);
    assert.deepEqual(retryReplay.json().data, retryExecute.json().data);
    const retryChangedReplay = await adminOperationsRequest('execute', {
        ...retryExecutePayload,
        reason: 'Changed acceptance retry',
    });
    assert.equal(retryChangedReplay.statusCode, 409, retryChangedReplay.body);

    const cancelStalePayload = operationsInput({
        section: 'operations',
        id: operationsCancelJobId,
        action: 'execute',
        operation: 'cancel',
        expectedVersion: '999',
        reason: 'Acceptance stale cancellation',
    });
    const cancelStale = await adminOperationsRequest('execute', cancelStalePayload);
    assert.equal(cancelStale.statusCode, 409, cancelStale.body);
    const cancelExecutePayload = {
        ...cancelStalePayload,
        expectedVersion: '1',
        idempotencyKey: randomUUID(),
        reason: 'Acceptance cancel pending import',
    };
    const cancelExecute = await adminOperationsRequest('execute', cancelExecutePayload);
    assert.equal(cancelExecute.statusCode, 200, cancelExecute.body);
    assert.equal(cancelExecute.json().data.status, 'cancelled');
    assert.equal(cancelExecute.json().data.version, '2');

    const concurrentJobBase = operationsInput({
        section: 'operations',
        id: operationsConcurrentJobId,
        action: 'execute',
        operation: 'retry',
        reason: 'Acceptance concurrent retry',
    });
    const concurrentJobResponses = await Promise.all([
        adminOperationsRequest('execute', concurrentJobBase),
        adminOperationsRequest('execute', { ...concurrentJobBase, idempotencyKey: randomUUID() }),
    ]);
    assert.deepEqual(concurrentJobResponses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(concurrentJobResponses.find((response) => response.statusCode === 200)?.json().data.status, 'queued');

    const incidentInspectPayload = operationsInput({
        section: 'errors',
        id: operationsIncidentId,
        action: 'inspect',
        operation: 'in_progress',
        reason: 'Acceptance inspect incident',
    });
    const incidentInspect = await adminOperationsRequest('inspect', incidentInspectPayload);
    assert.equal(incidentInspect.statusCode, 200, incidentInspect.body);
    assert.equal(incidentInspect.json().data.status, 'new');
    assert.equal(incidentInspect.json().data.version, '1');
    assert.equal(incidentInspect.json().data.failure, 'Sanitized lifecycle acceptance incident');
    const incidentPreview = await adminOperationsRequest('preview', {
        ...incidentInspectPayload,
        action: 'preview',
        idempotencyKey: randomUUID(),
    });
    assert.equal(incidentPreview.statusCode, 200, incidentPreview.body);
    assert.deepEqual(incidentPreview.json().data.preview, {
        summary: 'Инцидент отмечается как взятый в работу.',
        critical: false,
    });
    const incidentProgressPayload = {
        ...incidentInspectPayload,
        action: 'execute',
        idempotencyKey: randomUUID(),
        reason: 'Acceptance take incident',
    };
    const incidentProgress = await adminOperationsRequest('execute', incidentProgressPayload);
    assert.equal(incidentProgress.statusCode, 200, incidentProgress.body);
    assert.equal(incidentProgress.json().data.status, 'in_progress');
    assert.equal(incidentProgress.json().data.version, '2');
    const incidentProgressReplay = await adminOperationsRequest('execute', incidentProgressPayload);
    assert.equal(incidentProgressReplay.statusCode, 200, incidentProgressReplay.body);
    assert.deepEqual(incidentProgressReplay.json().data, incidentProgress.json().data);
    const incidentProgressChangedReplay = await adminOperationsRequest('execute', {
        ...incidentProgressPayload,
        reason: 'Changed acceptance incident reason',
    });
    assert.equal(incidentProgressChangedReplay.statusCode, 409, incidentProgressChangedReplay.body);
    const incidentStale = await adminOperationsRequest(
        'execute',
        operationsInput({
            section: 'errors',
            id: operationsIncidentId,
            action: 'execute',
            operation: 'resolved',
            expectedVersion: '1',
            reason: 'Acceptance stale incident resolution',
        }),
    );
    assert.equal(incidentStale.statusCode, 409, incidentStale.body);
    const incidentResolved = await adminOperationsRequest(
        'execute',
        operationsInput({
            section: 'errors',
            id: operationsIncidentId,
            action: 'execute',
            operation: 'resolved',
            expectedVersion: '2',
            reason: 'Acceptance resolve incident',
        }),
    );
    assert.equal(incidentResolved.statusCode, 200, incidentResolved.body);
    assert.equal(incidentResolved.json().data.status, 'resolved');
    assert.equal(incidentResolved.json().data.version, '3');
    const ignoreUntil = new Date(Date.now() + 86_400_000).toISOString();
    const incidentIgnored = await adminOperationsRequest(
        'execute',
        operationsInput({
            section: 'errors',
            id: operationsIncidentId,
            action: 'execute',
            operation: 'ignored',
            expectedVersion: '3',
            reason: 'Acceptance temporarily ignore incident',
            ignoreUntil,
        }),
    );
    assert.equal(incidentIgnored.statusCode, 200, incidentIgnored.body);
    assert.equal(incidentIgnored.json().data.status, 'ignored');
    assert.equal(incidentIgnored.json().data.version, '4');
    {
        const client = await ownerPool.connect();
        try {
            await client.query('begin isolation level serializable');
            await client.query(
                `update meal.admin_incident_states set ignored_until=now()-interval '1 second' where event_id=$1`,
                [operationsIncidentId],
            );
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
    const incidentExpired = await adminOperationsRequest('inspect', {
        ...incidentInspectPayload,
        expectedVersion: '4',
        idempotencyKey: randomUUID(),
    });
    assert.equal(incidentExpired.statusCode, 200, incidentExpired.body);
    assert.equal(incidentExpired.json().data.status, 'new');
    const incidentNew = await adminOperationsRequest(
        'execute',
        operationsInput({
            section: 'errors',
            id: operationsIncidentId,
            action: 'execute',
            operation: 'new',
            expectedVersion: '4',
            reason: 'Acceptance return incident to new',
        }),
    );
    assert.equal(incidentNew.statusCode, 200, incidentNew.body);
    assert.equal(incidentNew.json().data.status, 'new');
    assert.equal(incidentNew.json().data.version, '5');

    const concurrentIncidentBase = operationsInput({
        section: 'errors',
        id: operationsConcurrentIncidentId,
        action: 'execute',
        operation: 'in_progress',
        reason: 'Acceptance concurrent incident transition',
    });
    const concurrentIncidentResponses = await Promise.all([
        adminOperationsRequest('execute', concurrentIncidentBase),
        adminOperationsRequest('execute', {
            ...concurrentIncidentBase,
            operation: 'resolved',
            idempotencyKey: randomUUID(),
        }),
    ]);
    assert.deepEqual(concurrentIncidentResponses.map((response) => response.statusCode).sort(), [200, 409]);
    const concurrentIncidentWinner = concurrentIncidentResponses.find((response) => response.statusCode === 200);
    assert.ok(['in_progress', 'resolved'].includes(concurrentIncidentWinner?.json().data.status));
    assert.equal(concurrentIncidentWinner?.json().data.version, '2');

    const adminOperationsEffects = await pool.query(
        `select
           (select jsonb_object_agg(id::text,jsonb_build_object('status',status,'version',version))
              from meal.background_jobs where id=any($1::uuid[])) jobs,
           (select count(*)::int from meal.admin_incident_states where event_id=any($2::uuid[])) incident_states,
           (select count(*)::int from meal.idempotency_records
              where actor_namespace=$3 and operation='admin.operations.execute'
                and target_binding=any($4::text[])) idempotency,
           (select count(*)::int from meal.audit_events
              where actor_id=$5 and action like 'admin.operations.%' and target_id=any($1::uuid[] || $2::uuid[])) audits,
           (select count(*)::int from meal.audit_events
              where actor_id=$5 and target_id=$6 and action='admin.operations.in_progress') progress_audits,
           (select status from meal.admin_incident_states where event_id=$6) lifecycle_status,
           (select version::int from meal.admin_incident_states where event_id=$6) lifecycle_version,
           (select version::int from meal.admin_incident_states where event_id=$7) concurrent_incident_version`,
        [
            [operationsRetryJobId, operationsCancelJobId, operationsConcurrentJobId],
            [operationsIncidentId, operationsConcurrentIncidentId],
            `admin:${userId}`,
            [
                operationsRetryJobId,
                operationsCancelJobId,
                operationsConcurrentJobId,
                operationsIncidentId,
                operationsConcurrentIncidentId,
            ],
            userId,
            operationsIncidentId,
            operationsConcurrentIncidentId,
        ],
    );
    assert.deepEqual(adminOperationsEffects.rows[0].jobs[operationsRetryJobId], { status: 'queued', version: 2 });
    assert.deepEqual(adminOperationsEffects.rows[0].jobs[operationsCancelJobId], { status: 'cancelled', version: 2 });
    assert.deepEqual(adminOperationsEffects.rows[0].jobs[operationsConcurrentJobId], { status: 'queued', version: 2 });
    assert.deepEqual(
        {
            incident_states: adminOperationsEffects.rows[0].incident_states,
            idempotency: adminOperationsEffects.rows[0].idempotency,
            audits: adminOperationsEffects.rows[0].audits,
            progress_audits: adminOperationsEffects.rows[0].progress_audits,
            lifecycle_status: adminOperationsEffects.rows[0].lifecycle_status,
            lifecycle_version: adminOperationsEffects.rows[0].lifecycle_version,
            concurrent_incident_version: adminOperationsEffects.rows[0].concurrent_incident_version,
        },
        {
            incident_states: 2,
            idempotency: 8,
            audits: 8,
            progress_audits: 1,
            lifecycle_status: 'new',
            lifecycle_version: 5,
            concurrent_incident_version: 2,
        },
    );
    console.log(
        `ADMIN_OPERATIONS_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'admin-operations-live-v1',
            operationIds: [
                'OperationsWorkspaceController_inspect',
                'OperationsWorkspaceController_preview',
                'OperationsWorkspaceController_execute',
            ],
            effects: adminOperationsEffects.rows[0],
            assertions: {
                authenticatedUnlockedGate: true,
                csrfFailClosed: true,
                routeActionBinding: true,
                criticalConfirmationNotRequired: true,
                backgroundRetryCancel: true,
                incidentLifecycle: true,
                expiredIgnoreReadback: true,
                audit: true,
                idempotentReplay: true,
                changedReplayRollback: true,
                staleVersionRollback: true,
                concurrentSingleWinner: true,
                databaseEffects: true,
            },
        })}`,
    );

    const staffLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/staff/auth/login',
        headers: headers(),
        remoteAddress: '198.25.0.5',
        payload: {
            email: `moderator-${suffix}@example.test`,
            password: 'AcceptancePassword1!',
            context: 'moderator',
        },
    });
    assert.equal(staffLogin.statusCode, 200, staffLogin.body);
    assert.equal(staffLogin.json().data.status, 'mfa_required');
    assert.match(staffLogin.json().data.enrollment.secret, /^[A-Z2-7]+$/);
    const staffTotp = generateSync({
        secret: staffLogin.json().data.enrollment.secret,
        period: 30,
        digits: 6,
        epoch: Math.floor(Date.now() / 1000),
    });
    const staffVerify = await app.inject({
        method: 'POST',
        url: '/api/v1/staff/auth/mfa/verify',
        headers: headers(),
        remoteAddress: '198.25.0.6',
        payload: { challenge: staffLogin.json().data.challenge, code: staffTotp, method: 'totp' },
    });
    assert.equal(staffVerify.statusCode, 200, staffVerify.body);
    assert.equal(staffVerify.json().data.user.id, secondModeratorId);
    assert.equal(staffVerify.json().data.user.context, 'moderator');
    assert.equal(staffVerify.json().data.recoveryCodes.length, 10);
    assert.match(
        staffVerify.cookies.find((cookie) => cookie.name === 'meal_staff')?.value ?? '',
        /^[A-Za-z0-9_-]{43}$/,
    );
    const staffAuthEffects = await pool.query(
        `select
           s.revoked_at is null as active,s.mfa_verified_at is not null as mfa_verified,
           (select count(*)::int from meal.auth_challenges c
             where c.user_id=$2 and c.purpose='staff_login' and c.used_at is not null) as used_challenges,
           (select count(*)::int from meal.audit_events a
             where a.actor_id=$2 and a.action='auth.session.created' and a.target_id=s.id) as session_audits
         from meal.sessions s where s.id=$1`,
        [staffVerify.json().data.user.sessionId, secondModeratorId],
    );
    assert.deepEqual(staffAuthEffects.rows[0], {
        active: true,
        mfa_verified: true,
        used_challenges: 1,
        session_audits: 1,
    });
    console.log(
        `AUTH_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'admin-staff-auth-live-v1',
            operationIds: [
                'AdminAuthController_login',
                'AdminAuthController_verify',
                'AdminAuthController_status',
                'AdminAuthController_unlock',
                'AdminAuthController_confirm',
                'StaffAuthController_login',
                'StaffAuthController_verify',
            ],
            assertions: { challenge: true, totp: true, recovery: true, session: true, audit: true },
        })}`,
    );

    // Exact account and account-lifecycle acceptance. The development mailbox below is an isolated
    // token-delivery test adapter; it is deliberately not evidence for production SMTP delivery.
    let accountRequestIndex = 0;
    const newAccountClient = async () => {
        const bootstrap = await app.inject({
            method: 'GET',
            url: '/api/v1/auth/csrf',
            remoteAddress: `198.26.${Math.floor(accountRequestIndex / 250)}.${(accountRequestIndex++ % 250) + 1}`,
        });
        assert.equal(bootstrap.statusCode, 200, bootstrap.body);
        const jar = new Map(bootstrap.cookies.map((cookie) => [cookie.name, cookie.value]));
        const csrfValue = bootstrap.json().data.token;
        const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        const request = async (method, url, payload, options = {}) => {
            const response = await app.inject({
                method,
                url,
                headers: {
                    origin: config.FRONTEND_ORIGIN,
                    cookie: cookieHeader(),
                    ...(method === 'GET' || options.csrf === false ? {} : { 'x-csrf-token': csrfValue }),
                },
                remoteAddress: `198.26.${Math.floor(accountRequestIndex / 250)}.${(accountRequestIndex++ % 250) + 1}`,
                ...(payload === undefined ? {} : { payload }),
            });
            if (options.cookies !== false)
                for (const cookie of response.cookies) {
                    if (cookie.value) jar.set(cookie.name, cookie.value);
                    else jar.delete(cookie.name);
                }
            return response;
        };
        return { jar, request, cookieHeader };
    };
    const accountManifest = await app.inject({ method: 'GET', url: '/api/v1/legal/manifest' });
    assert.equal(accountManifest.statusCode, 200, accountManifest.body);
    const registrationDocument = (kind) => {
        const found = accountManifest.json().data.documents.find((item) => item.kind === kind)?.document;
        assert.ok(found, `${kind} registration document`);
        return found;
    };
    const registrationLegal = {
        offerAcceptance: { accepted: true, document: registrationDocument('offer') },
        privacyAcknowledgement: { acknowledged: true, document: registrationDocument('privacy_notice') },
    };
    const accountPassword = 'AccountExactPassword1!';
    const ageAccountRateLimits = async () => {
        await ownerPool.query('begin isolation level serializable');
        try {
            await ownerPool.query(`update meal.auth_rate_limits set window_started_at=now()-interval '1 day'`);
            await ownerPool.query('commit');
        } catch (error) {
            await ownerPool.query('rollback');
            throw error;
        }
    };
    const mailboxToken = async (client, address, kind) => {
        const mailboxResponse = await client.request('POST', '/api/v1/dev/mailbox', { email: address });
        assert.equal(mailboxResponse.statusCode, 200, mailboxResponse.body);
        const value = mailboxResponse.json().data.messages.find((message) => message.kind === kind)?.token;
        assert.match(value ?? '', /^[A-Za-z0-9_-]{43}$/);
        return value;
    };
    const registerVerifiedAccount = async (label, version2 = false) => {
        const client = await newAccountClient();
        const address = `${label}-${suffix}@example.test`;
        const username = `${label}_${suffix}`.slice(0, 30);
        const registrationResponse = await client.request(
            'POST',
            version2 ? '/api/v1/auth/register/v2' : '/api/v1/auth/register',
            version2
                ? {
                      username,
                      displayName: `Exact ${label}`,
                      email: address,
                      password: accountPassword,
                      legal: registrationLegal,
                  }
                : {
                      username,
                      displayName: `Exact ${label}`,
                      email: address,
                      password: accountPassword,
                      acceptTerms: true,
                      acceptPrivacy: true,
                  },
        );
        assert.equal(registrationResponse.statusCode, 200, registrationResponse.body);
        if (version2) {
            const duplicate = await client.request('POST', '/api/v1/auth/register/v2', {
                username,
                displayName: `Exact ${label}`,
                email: address,
                password: accountPassword,
                legal: registrationLegal,
            });
            assert.equal(duplicate.statusCode, 200, duplicate.body);
        }
        const verifyToken = await mailboxToken(client, address, 'verify');
        const verified = await client.request('POST', '/api/v1/auth/email/verify', { token: verifyToken });
        assert.equal(verified.statusCode, 200, verified.body);
        const loginResponse = await client.request('POST', '/api/v1/auth/login', {
            email: address,
            password: accountPassword,
        });
        assert.equal(loginResponse.statusCode, 200, loginResponse.body);
        return {
            ...client,
            address,
            username,
            userId: loginResponse.json().data.user.id,
            sessionId: loginResponse.json().data.user.sessionId,
        };
    };

    const grantFamilyPlan = async (targetUserId, code = 'plus') => {
        const subscriptionId = randomUUID();
        await ownerPool.query('begin isolation level serializable');
        try {
            const product = await ownerPool.query('select id from meal.billing_products where code=$1', [code]);
            assert.equal(product.rows.length, 1, `${code} family product fixture`);
            await ownerPool.query(
                `insert into meal.subscriptions(id,status,auto_renew,billing_anchor,billing_timezone,owner_id,product_id)
                 values($1,'active',false,now(),'Europe/Moscow',$2,$3)`,
                [subscriptionId, targetUserId, product.rows[0].id],
            );
            await ownerPool.query(
                `insert into meal.subscription_periods(id,starts_at,ends_at,grant_kind,price_snapshot,subscription_id)
                 values($1,now()-interval '1 day',now()+interval '30 days','trial',null,$2)`,
                [randomUUID(), subscriptionId],
            );
            await ownerPool.query('commit');
        } catch (error) {
            await ownerPool.query('rollback');
            throw error;
        }
        return subscriptionId;
    };
    const familyOwner = await registerVerifiedAccount('familyowner');
    const familyMember = await registerVerifiedAccount('familymember');
    const familySecondMember = await registerVerifiedAccount('familysecond');
    const familyCancelledInvitee = await registerVerifiedAccount('familycancelled');
    const familyOutsider = await registerVerifiedAccount('familyoutsider');
    const familyAutoSuccessor = await registerVerifiedAccount('familysuccessor');
    await grantFamilyPlan(familyOwner.userId);
    await grantFamilyPlan(familyMember.userId);
    await grantFamilyPlan(familyOutsider.userId);
    await grantFamilyPlan(familyAutoSuccessor.userId);

    const familyCreated = await familyOwner.request('POST', '/api/v1/family', {
        name: `Exact family ${suffix}`,
        idempotencyKey: randomUUID(),
    });
    assert.equal(familyCreated.statusCode, 201, familyCreated.body);
    const familyId = familyCreated.json().data.family.id;
    let familyVersion = familyCreated.json().data.family.version;
    const directInvitePayload = {
        login: familyMember.username,
        expectedVersion: familyVersion,
        idempotencyKey: randomUUID(),
    };
    const directInvite = await familyOwner.request('POST', '/api/v1/family/invitations', directInvitePayload);
    assert.equal(directInvite.statusCode, 201, directInvite.body);
    assert.equal(directInvite.json().data.invitation.status, 'pending');
    assert.ok(directInvite.json().data.token);
    const directInviteReplay = await familyOwner.request('POST', '/api/v1/family/invitations', directInvitePayload);
    assert.equal(directInviteReplay.statusCode, 201, directInviteReplay.body);
    assert.deepEqual(directInviteReplay.json().data, directInvite.json().data);
    const invitePreview = await familyMember.request(
        'GET',
        `/api/v1/family/invitation-preview?token=${encodeURIComponent(directInvite.json().data.token)}`,
    );
    assert.equal(invitePreview.statusCode, 200, invitePreview.body);
    assert.equal(invitePreview.json().data.status, 'pending');
    const acceptInvitePayload = {
        token: directInvite.json().data.token,
        expectedFamilyVersion: invitePreview.json().data.familyVersion,
        idempotencyKey: randomUUID(),
    };
    const acceptedInvite = await familyMember.request('POST', '/api/v1/family/invitation-accept', acceptInvitePayload);
    if (acceptedInvite.statusCode === 500) {
        try {
            await app.get(FamilyService).acceptInvitation(
                acceptInvitePayload,
                {
                    id: familyMember.userId,
                    displayName: 'Exact family member',
                    context: 'user',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    sessionId: familyMember.sessionId,
                },
                randomUUID(),
            );
        } catch (error) {
            const classification =
                error && typeof error === 'object' && 'code' in error
                    ? `${String(error.code)}:${'column' in error ? String(error.column) : ''}:${'constraint' in error ? String(error.constraint) : ''}:${'message' in error ? String(error.message).slice(0, 200) : ''}`
                    : (error?.constructor?.name ?? 'UnknownError');
            throw new Error(`FamilyController_acceptInvitation: ${classification}`);
        }
    }
    assert.equal(acceptedInvite.statusCode, 200, acceptedInvite.body);
    assert.equal(acceptedInvite.json().data.family.memberCount, 2);
    const acceptedInviteReplay = await familyMember.request(
        'POST',
        '/api/v1/family/invitation-accept',
        acceptInvitePayload,
    );
    assert.equal(acceptedInviteReplay.statusCode, 200, acceptedInviteReplay.body);
    assert.deepEqual(acceptedInviteReplay.json().data, acceptedInvite.json().data);
    familyVersion = acceptedInvite.json().data.family.version;

    const proposedInvite = await familyMember.request('POST', '/api/v1/family/invitations', {
        login: familySecondMember.username,
        expectedVersion: familyVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(proposedInvite.statusCode, 201, proposedInvite.body);
    assert.equal(proposedInvite.json().data.invitation.status, 'proposed');
    assert.equal(proposedInvite.json().data.token, null);
    const approvedInvitePayload = {
        expectedVersion: proposedInvite.json().data.invitation.version,
        idempotencyKey: randomUUID(),
    };
    const approvedInvite = await familyOwner.request(
        'POST',
        `/api/v1/family/invitations/${proposedInvite.json().data.invitation.id}/approve`,
        approvedInvitePayload,
    );
    assert.equal(approvedInvite.statusCode, 200, approvedInvite.body);
    assert.equal(approvedInvite.json().data.invitation.status, 'pending');
    assert.ok(approvedInvite.json().data.token);
    const secondPreview = await familySecondMember.request(
        'GET',
        `/api/v1/family/invitation-preview?token=${encodeURIComponent(approvedInvite.json().data.token)}`,
    );
    assert.equal(secondPreview.statusCode, 200, secondPreview.body);
    const secondAccepted = await familySecondMember.request('POST', '/api/v1/family/invitation-accept', {
        token: approvedInvite.json().data.token,
        expectedFamilyVersion: secondPreview.json().data.familyVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(secondAccepted.statusCode, 200, secondAccepted.body);
    assert.equal(secondAccepted.json().data.family.memberCount, 3);
    familyVersion = secondAccepted.json().data.family.version;

    const cancellableInvite = await familyMember.request('POST', '/api/v1/family/invitations', {
        login: familyCancelledInvitee.username,
        expectedVersion: familyVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(cancellableInvite.statusCode, 201, cancellableInvite.body);
    assert.equal(cancellableInvite.json().data.invitation.status, 'proposed');
    const cancelledInvite = await familyMember.request(
        'POST',
        `/api/v1/family/invitations/${cancellableInvite.json().data.invitation.id}/cancel`,
        {
            expectedVersion: cancellableInvite.json().data.invitation.version,
            idempotencyKey: randomUUID(),
        },
    );
    assert.equal(cancelledInvite.statusCode, 200, cancelledInvite.body);
    assert.equal(cancelledInvite.json().data.invitation.status, 'cancelled');
    const ownerInvitations = await familyOwner.request('GET', '/api/v1/family/invitations');
    const memberInvitations = await familyMember.request('GET', '/api/v1/family/invitations');
    assert.equal(ownerInvitations.statusCode, 200, ownerInvitations.body);
    assert.equal(memberInvitations.statusCode, 200, memberInvitations.body);
    assert.equal(ownerInvitations.json().data.items.length, 3);
    assert.equal(memberInvitations.json().data.items.length, 2);

    const noteCreatePayload = {
        kind: 'checklist',
        title: 'Exact family checklist',
        body: 'Shared acceptance checklist',
        items: [{ text: 'First item' }, { text: 'Second item' }],
        idempotencyKey: randomUUID(),
    };
    const noteCreated = await familyOwner.request('POST', '/api/v1/family/notes', noteCreatePayload);
    assert.equal(noteCreated.statusCode, 201, noteCreated.body);
    const noteCreatedReplay = await familyOwner.request('POST', '/api/v1/family/notes', noteCreatePayload);
    assert.equal(noteCreatedReplay.statusCode, 201, noteCreatedReplay.body);
    assert.deepEqual(noteCreatedReplay.json().data, noteCreated.json().data);
    const noteId = noteCreated.json().data.id;
    const firstItemId = noteCreated.json().data.items[0].id;
    const memberNote = await familyMember.request('GET', `/api/v1/family/notes/${noteId}`);
    assert.equal(memberNote.statusCode, 200, memberNote.body);
    assert.equal(memberNote.json().data.canEdit, false);
    const noteList = await familyMember.request('GET', '/api/v1/family/notes?q=checklist&tab=active');
    assert.equal(noteList.statusCode, 200, noteList.body);
    assert.deepEqual(
        noteList.json().data.items.map((item) => item.id),
        [noteId],
    );
    const toggledNote = await familyMember.request(
        'POST',
        `/api/v1/family/notes/${noteId}/items/${firstItemId}/toggle`,
        {
            expectedNoteVersion: noteCreated.json().data.version,
            expectedItemVersion: noteCreated.json().data.items[0].version,
            checked: true,
            idempotencyKey: randomUUID(),
        },
    );
    assert.equal(toggledNote.statusCode, 200, toggledNote.body);
    assert.equal(toggledNote.json().data.items[0].checked, true);
    const noteUpdatePayloads = ['Concurrent title A', 'Concurrent title B'].map((title) => ({
        kind: 'checklist',
        title,
        body: 'Updated shared checklist',
        items: toggledNote.json().data.items.map((item) => ({ id: item.id, text: item.text })),
        expectedVersion: toggledNote.json().data.version,
        idempotencyKey: randomUUID(),
    }));
    const noteUpdates = await Promise.all(
        noteUpdatePayloads.map((payload) => familyOwner.request('PUT', `/api/v1/family/notes/${noteId}`, payload)),
    );
    assert.deepEqual(
        noteUpdates.map((response) => response.statusCode).sort((left, right) => left - right),
        [200, 412],
    );
    const updatedNote = noteUpdates.find((response) => response.statusCode === 200).json().data;
    const noteHistory = await familyMember.request('GET', `/api/v1/family/notes/${noteId}/history`);
    assert.equal(noteHistory.statusCode, 200, noteHistory.body);
    assert.equal(noteHistory.json().data.items.length, 3);
    const archivedNote = await familyOwner.request('POST', `/api/v1/family/notes/${noteId}/archive`, {
        expectedVersion: updatedNote.version,
        archived: true,
        idempotencyKey: randomUUID(),
    });
    assert.equal(archivedNote.statusCode, 200, archivedNote.body);
    assert.ok(archivedNote.json().data.archivedAt);
    assert.equal(
        (await familyMember.request('GET', '/api/v1/family/notes?tab=archived')).json().data.items[0].id,
        noteId,
    );

    await runQueryOptimizationsAcceptance({
        ownerPool,
        pool,
        familyClient: familyOwner,
        familyId,
        familyUserId: familyOwner.userId,
        app,
        requestHeaders: headers(),
        moderatorUserId: secondModeratorId,
        recipeRevisionId: recipeFixtures[0].revisionId,
        explain,
    });

    const draftPayload = { body: 'Exact draft', expectedVersion: null, idempotencyKey: randomUUID() };
    const draft = await familyOwner.request('PUT', '/api/v1/family/chat/draft', draftPayload);
    assert.equal(draft.statusCode, 200, draft.body);
    assert.equal(draft.json().data.version, 1);
    const draftReplay = await familyOwner.request('PUT', '/api/v1/family/chat/draft', draftPayload);
    assert.equal(draftReplay.statusCode, 200, draftReplay.body);
    assert.deepEqual(draftReplay.json().data, draft.json().data);
    const chatSendPayload = {
        body: 'Exact family message',
        replyToId: null,
        mentionUserIds: [familyMember.userId],
        idempotencyKey: randomUUID(),
    };
    const sentMessage = await familyOwner.request('POST', '/api/v1/family/chat/messages', chatSendPayload);
    assert.equal(sentMessage.statusCode, 201, sentMessage.body);
    const sentReplay = await familyOwner.request('POST', '/api/v1/family/chat/messages', chatSendPayload);
    assert.equal(sentReplay.statusCode, 201, sentReplay.body);
    assert.deepEqual(sentReplay.json().data, sentMessage.json().data);
    const messageId = sentMessage.json().data.message.id;
    const memberChat = await familyMember.request('GET', '/api/v1/family/chat?q=Exact&limit=30');
    assert.equal(memberChat.statusCode, 200, memberChat.body);
    assert.equal(memberChat.json().data.items[0].id, messageId);
    const reacted = await familyMember.request('POST', `/api/v1/family/chat/messages/${messageId}/reaction`, {
        reaction: 'heart',
        active: true,
        idempotencyKey: randomUUID(),
    });
    assert.equal(reacted.statusCode, 200, reacted.body);
    assert.equal(reacted.json().data.message.reactions[0].count, 1);
    const pinned = await familyMember.request('POST', `/api/v1/family/chat/messages/${messageId}/pin`, {
        pinned: true,
        idempotencyKey: randomUUID(),
    });
    assert.equal(pinned.statusCode, 200, pinned.body);
    assert.equal(pinned.json().data.message.pinned, true);
    const readMessage = await familyMember.request('POST', '/api/v1/family/chat/read', {
        messageId,
        idempotencyKey: randomUUID(),
    });
    assert.equal(readMessage.statusCode, 200, readMessage.body);
    const editedMessage = await familyOwner.request('PUT', `/api/v1/family/chat/messages/${messageId}`, {
        body: 'Exact family message edited',
        mentionUserIds: [familySecondMember.userId],
        expectedVersion: sentMessage.json().data.message.version,
        idempotencyKey: randomUUID(),
    });
    assert.equal(editedMessage.statusCode, 200, editedMessage.body);
    assert.equal(editedMessage.json().data.message.version, sentMessage.json().data.message.version + 1);
    const hiddenMessage = await familyMember.request('POST', `/api/v1/family/chat/messages/${messageId}/hide`, {
        idempotencyKey: randomUUID(),
    });
    assert.equal(hiddenMessage.statusCode, 200, hiddenMessage.body);
    assert.equal(hiddenMessage.json().data.message, null);
    assert.equal(
        (await familyMember.request('GET', '/api/v1/family/chat'))
            .json()
            .data.items.some((item) => item.id === messageId),
        false,
    );
    const removedMessage = await familyOwner.request('POST', `/api/v1/family/chat/messages/${messageId}/remove`, {
        expectedVersion: editedMessage.json().data.message.version,
        idempotencyKey: randomUUID(),
    });
    assert.equal(removedMessage.statusCode, 200, removedMessage.body);
    assert.equal(removedMessage.json().data.message.body, '');
    assert.ok(removedMessage.json().data.message.removedForAllAt);

    const outsiderFamily = await familyOutsider.request('POST', '/api/v1/family', {
        name: `Isolation family ${suffix}`,
        idempotencyKey: randomUUID(),
    });
    assert.equal(outsiderFamily.statusCode, 201, outsiderFamily.body);
    assert.equal((await familyOutsider.request('GET', `/api/v1/family/notes/${noteId}`)).statusCode, 404);
    assert.equal(
        (
            await familyOutsider.request('POST', `/api/v1/family/chat/messages/${messageId}/reaction`, {
                reaction: 'like',
                active: true,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        404,
    );

    const ownershipWorkspace = await familyOwner.request('GET', '/api/v1/family/ownership');
    assert.equal(ownershipWorkspace.statusCode, 200, ownershipWorkspace.body);
    const targetMembershipId = ownershipWorkspace
        .json()
        .data.candidates.find((candidate) => candidate.userId === familyMember.userId).id;
    const createOwnership = async () => {
        const preview = await familyOwner.request('POST', '/api/v1/family/ownership/preview', {
            targetMembershipId,
            expectedFamilyVersion: familyVersion,
        });
        assert.equal(preview.statusCode, 200, preview.body);
        assert.equal(preview.json().data.canSubmit, true);
        const payload = {
            targetMembershipId,
            expectedFamilyVersion: familyVersion,
            previewKey: preview.json().data.previewKey,
            idempotencyKey: randomUUID(),
        };
        const created = await familyOwner.request('POST', '/api/v1/family/ownership/requests', payload);
        assert.equal(created.statusCode, 201, created.body);
        const replay = await familyOwner.request('POST', '/api/v1/family/ownership/requests', payload);
        assert.equal(replay.statusCode, 201, replay.body);
        assert.deepEqual(replay.json().data, created.json().data);
        return created.json().data;
    };
    const declinedRequest = await createOwnership();
    const ownershipDetail = await familyMember.request(
        'GET',
        `/api/v1/family/ownership/requests/${declinedRequest.token}`,
    );
    assert.equal(ownershipDetail.statusCode, 200, ownershipDetail.body);
    const declined = await familyMember.request(
        'POST',
        `/api/v1/family/ownership/requests/${declinedRequest.token}/decline`,
        {
            expectedVersion: declinedRequest.request.version,
            expectedFamilyVersion: familyVersion,
            idempotencyKey: randomUUID(),
        },
    );
    assert.equal(declined.statusCode, 200, declined.body);
    assert.equal(declined.json().data.request.status, 'declined');

    const cancelledRequest = await createOwnership();
    const cancelledOwnership = await familyOwner.request(
        'POST',
        `/api/v1/family/ownership/requests/${cancelledRequest.token}/cancel`,
        {
            expectedVersion: cancelledRequest.request.version,
            expectedFamilyVersion: familyVersion,
            idempotencyKey: randomUUID(),
        },
    );
    assert.equal(cancelledOwnership.statusCode, 200, cancelledOwnership.body);
    assert.equal(cancelledOwnership.json().data.request.status, 'cancelled');

    const acceptedRequest = await createOwnership();
    const acceptedOwnership = await familyMember.request(
        'POST',
        `/api/v1/family/ownership/requests/${acceptedRequest.token}/accept`,
        {
            expectedVersion: acceptedRequest.request.version,
            expectedFamilyVersion: familyVersion,
            idempotencyKey: randomUUID(),
        },
    );
    assert.equal(acceptedOwnership.statusCode, 200, acceptedOwnership.body);
    assert.equal(acceptedOwnership.json().data.request.status, 'accepted');
    assert.equal(acceptedOwnership.json().data.family.family.role, 'owner');
    familyVersion = acceptedOwnership.json().data.family.family.version;
    const secondMembershipId = acceptedOwnership
        .json()
        .data.family.family.members.find((candidate) => candidate.userId === familySecondMember.userId).id;
    const removedMember = await familyMember.request('POST', `/api/v1/family/members/${secondMembershipId}/remove`, {
        expectedVersion: familyVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(removedMember.statusCode, 200, removedMember.body);
    assert.equal(removedMember.json().data.family.memberCount, 2);

    const autoInvite = await familyOutsider.request('POST', '/api/v1/family/invitations', {
        login: familyAutoSuccessor.username,
        expectedVersion: outsiderFamily.json().data.family.version,
        idempotencyKey: randomUUID(),
    });
    assert.equal(autoInvite.statusCode, 201, autoInvite.body);
    const autoPreview = await familyAutoSuccessor.request(
        'GET',
        `/api/v1/family/invitation-preview?token=${encodeURIComponent(autoInvite.json().data.token)}`,
    );
    assert.equal(autoPreview.statusCode, 200, autoPreview.body);
    const autoAccepted = await familyAutoSuccessor.request('POST', '/api/v1/family/invitation-accept', {
        token: autoInvite.json().data.token,
        expectedFamilyVersion: autoPreview.json().data.familyVersion,
        idempotencyKey: randomUUID(),
    });
    assert.equal(autoAccepted.statusCode, 200, autoAccepted.body);
    const leavePreview = await familyOutsider.request('GET', '/api/v1/family/leave-preview');
    assert.equal(leavePreview.statusCode, 200, leavePreview.body);
    assert.equal(leavePreview.json().data.role, 'owner');
    assert.equal(leavePreview.json().data.willArchive, false);
    const leavePayload = {
        selection: 'automatic',
        successorMembershipId: null,
        expectedVersion: leavePreview.json().data.familyVersion,
        idempotencyKey: randomUUID(),
    };
    const leftFamily = await familyOutsider.request('POST', '/api/v1/family/leave', leavePayload);
    assert.equal(leftFamily.statusCode, 200, leftFamily.body);
    assert.equal(leftFamily.json().data.archived, false);
    assert.equal(leftFamily.json().data.successorMembershipId, leavePreview.json().data.recommendedMembershipId);
    const leaveReplay = await familyOutsider.request('POST', '/api/v1/family/leave', leavePayload);
    assert.equal(leaveReplay.statusCode, 200, leaveReplay.body);
    assert.deepEqual(leaveReplay.json().data, leftFamily.json().data);
    const ownershipNotice = await familyAutoSuccessor.request('GET', '/api/v1/family/ownership-notice');
    assert.equal(ownershipNotice.statusCode, 200, ownershipNotice.body);
    assert.ok(ownershipNotice.json().data.notice);
    const dismissNoticePayload = {
        notificationId: ownershipNotice.json().data.notice.notificationId,
        expectedVersion: ownershipNotice.json().data.notice.version,
        idempotencyKey: randomUUID(),
    };
    const dismissedNotice = await familyAutoSuccessor.request(
        'POST',
        '/api/v1/family/ownership-notice/dismiss',
        dismissNoticePayload,
    );
    assert.equal(dismissedNotice.statusCode, 200, dismissedNotice.body);
    assert.deepEqual(dismissedNotice.json().data, { dismissed: true });
    assert.equal(
        (await familyAutoSuccessor.request('GET', '/api/v1/family/ownership-notice')).json().data.notice,
        null,
    );

    const familyEffects = await pool.query(
        `select
           (select count(*)::int from meal.family_invitations where family_id=$1) invitations,
           (select count(*)::int from meal.family_invitations where family_id=$1 and status='accepted') accepted_invitations,
           (select count(*)::int from meal.family_invitations where family_id=$1 and status='cancelled') cancelled_invitations,
           (select count(*)::int from meal.ownership_transfers where family_id=$1 and mode='voluntary') voluntary_transfers,
           (select count(*)::int from meal.ownership_transfers where family_id=$1 and status='accepted') accepted_transfers,
           (select count(*)::int from meal.family_memberships where family_id=$1 and left_at is null) active_members,
           (select count(*)::int from meal.family_notes where id=$2 and archived_at is not null) archived_notes,
           (select count(*)::int from meal.note_revisions where note_id=$2) note_revisions,
           (select count(*)::int from meal.audit_events where target_id=$2) note_audits,
           (select count(*)::int from meal.chat_messages where id=$3 and removed_for_all_at is not null) removed_messages,
           (select count(*)::int from meal.chat_revisions where message_id=$3) chat_revisions,
           (select count(*)::int from meal.chat_reactions where message_id=$3) chat_reactions,
           (select count(*)::int from meal.chat_pins where message_id=$3 and unpinned_at is null) chat_pins,
           (select count(*)::int from meal.chat_receipts where message_id=$3 and user_id=$4 and read_at is not null) chat_receipts,
           (select count(*)::int from meal.user_hidden_objects where chat_message_id=$3 and user_id=$4) hidden_messages,
           (select count(*)::int from meal.idempotency_records where scope_id=(select id from meal.data_scopes where family_id=$1 and kind='family')) scoped_idempotency,
           (select count(*)::int from meal.audit_events where scope_id=(select id from meal.data_scopes where family_id=$1 and kind='family') and action like 'family.%') family_audits`,
        [familyId, noteId, messageId, familyMember.userId],
    );
    assert.deepEqual(familyEffects.rows[0], {
        invitations: 3,
        accepted_invitations: 2,
        cancelled_invitations: 1,
        voluntary_transfers: 3,
        accepted_transfers: 1,
        active_members: 2,
        archived_notes: 1,
        note_revisions: 4,
        note_audits: 4,
        removed_messages: 1,
        chat_revisions: 3,
        chat_reactions: 1,
        chat_pins: 1,
        chat_receipts: 1,
        hidden_messages: 1,
        scoped_idempotency: 21,
        family_audits: 9,
    });
    console.log(
        `FAMILY_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'family-live-happy-path-v1',
            operationIds: [
                'FamilyController_leavePreview',
                'FamilyController_leave',
                'FamilyController_removeMember',
                'FamilyController_ownershipNotice',
                'FamilyController_dismissOwnershipNotice',
                'FamilyController_ownership',
                'FamilyController_ownershipPreview',
                'FamilyController_createOwnershipRequest',
                'FamilyController_ownershipRequest',
                'FamilyController_acceptOwnership',
                'FamilyController_declineOwnership',
                'FamilyController_cancelOwnership',
                'FamilyController_invitations',
                'FamilyController_invite',
                'FamilyController_approveInvitation',
                'FamilyController_cancelInvitation',
                'FamilyController_invitationPreview',
                'FamilyController_acceptInvitation',
                'FamilyChatController_list',
                'FamilyChatController_send',
                'FamilyChatController_edit',
                'FamilyChatController_remove',
                'FamilyChatController_hide',
                'FamilyChatController_reaction',
                'FamilyChatController_pin',
                'FamilyChatController_draft',
                'FamilyChatController_read',
                'FamilyNotesController_list',
                'FamilyNotesController_create',
                'FamilyNotesController_detail',
                'FamilyNotesController_update',
                'FamilyNotesController_history',
                'FamilyNotesController_archive',
                'FamilyNotesController_toggle',
            ],
            effects: familyEffects.rows[0],
            assertions: {
                exactResponses: true,
                databaseEffects: true,
                auditEffects: true,
                idempotentReplay: true,
                optimisticConcurrencySingleWinner: true,
                ownershipAndMemberIsolation: true,
                explicitAndAutomaticOwnership: true,
                plusEntitlement: true,
                mixedCreateAndCommandStatuses: true,
            },
        })}`,
    );

    // Exact recipe-workspace acceptance: private authoring on Free, family ACL on Plus,
    // consent gates, optimistic concurrency, immutable history, community evidence and reports.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/recipe-workspace' })).statusCode, 401);
    const workspaceDocument = (title) => ({
        title,
        description: 'Exact PostgreSQL workspace recipe',
        category: 'acceptance',
        tags: ['exact', 'postgresql'],
        baseServings: 2,
        method: 'Приёмочный способ',
        ingredients: [
            {
                ingredientId: largeTenantIngredientId,
                variantId: null,
                productId: null,
                sourceRecipeId: null,
                quantity: '2',
                unit: 'pcs',
                optional: false,
            },
        ],
        steps: [{ text: 'Проверить транзакционный результат', durationSeconds: 60, temperature: null }],
    });
    const workspaceCreatePayload = {
        idempotencyKey: randomUUID(),
        scope: 'private',
        document: workspaceDocument('Exact private recipe'),
    };
    const workspaceCreated = await familyOwner.request('POST', '/api/v1/recipe-workspace', workspaceCreatePayload);
    assert.equal(workspaceCreated.statusCode, 200, workspaceCreated.body);
    assert.equal(workspaceCreated.json().data.recipe.version, 1);
    assert.equal(workspaceCreated.json().data.recipe.revision, 1);
    assert.equal(workspaceCreated.json().data.recipe.availabilityScope, 'private');
    const workspaceRecipeId = workspaceCreated.json().data.recipe.id;
    const workspaceCreateReplay = await familyOwner.request('POST', '/api/v1/recipe-workspace', workspaceCreatePayload);
    assert.equal(workspaceCreateReplay.statusCode, 200, workspaceCreateReplay.body);
    assert.deepEqual(workspaceCreateReplay.json().data, workspaceCreated.json().data);
    assert.equal(
        (
            await familyOwner.request('POST', '/api/v1/recipe-workspace', {
                ...workspaceCreatePayload,
                document: workspaceDocument('Altered replay must fail'),
            })
        ).statusCode,
        409,
    );
    const workspaceList = await familyOwner.request(
        'GET',
        `/api/v1/recipe-workspace?scope=private&status=active&q=${encodeURIComponent('Exact private')}&page=1&limit=10`,
    );
    assert.equal(workspaceList.statusCode, 200, workspaceList.body);
    assert.deepEqual(
        workspaceList.json().data.items.map((item) => item.id),
        [workspaceRecipeId],
    );
    const workspaceDetail = await familyOwner.request(
        'GET',
        `/api/v1/recipe-workspace/${workspaceRecipeId}?scope=private`,
    );
    assert.equal(workspaceDetail.statusCode, 200, workspaceDetail.body);
    assert.equal(workspaceDetail.json().data.recipe.canEdit, true);
    assert.equal(
        (await familyOutsider.request('GET', `/api/v1/recipe-workspace/${workspaceRecipeId}?scope=private`)).statusCode,
        404,
    );

    const workspaceSavePayload = {
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        document: workspaceDocument('Exact private recipe v2'),
    };
    const workspaceSaved = await familyOwner.request(
        'PUT',
        `/api/v1/recipe-workspace/${workspaceRecipeId}`,
        workspaceSavePayload,
    );
    assert.equal(workspaceSaved.statusCode, 200, workspaceSaved.body);
    assert.equal(workspaceSaved.json().data.recipe.version, 2);
    assert.equal(workspaceSaved.json().data.recipe.revision, 2);
    assert.equal(
        (
            await familyOwner.request('PUT', `/api/v1/recipe-workspace/${workspaceRecipeId}`, {
                ...workspaceSavePayload,
                idempotencyKey: randomUUID(),
                document: workspaceDocument('Stale write'),
            })
        ).statusCode,
        409,
    );
    assert.equal(
        (
            await familyOutsider.request('PUT', `/api/v1/recipe-workspace/${workspaceRecipeId}`, {
                ...workspaceSavePayload,
                expectedVersion: 2,
                idempotencyKey: randomUUID(),
            })
        ).statusCode,
        404,
    );
    const workspaceRollback = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/rollback`,
        { expectedVersion: 2, idempotencyKey: randomUUID() },
    );
    assert.equal(workspaceRollback.statusCode, 200, workspaceRollback.body);
    assert.equal(workspaceRollback.json().data.recipe.version, 3);
    assert.equal(workspaceRollback.json().data.recipe.revision, 3);
    assert.equal(workspaceRollback.json().data.recipe.document.title, 'Exact private recipe');
    const workspaceArchived = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/archive`,
        { expectedVersion: 3, idempotencyKey: randomUUID() },
    );
    assert.equal(workspaceArchived.statusCode, 200, workspaceArchived.body);
    assert.equal(workspaceArchived.json().data.recipe.archived, true);
    assert.equal(
        (
            await familyOwner.request(
                'GET',
                `/api/v1/recipe-workspace?scope=private&status=archived&q=${encodeURIComponent('Exact private')}`,
            )
        ).json().data.items[0].id,
        workspaceRecipeId,
    );
    const workspaceRestored = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/restore`,
        { expectedVersion: 4, idempotencyKey: randomUUID() },
    );
    assert.equal(workspaceRestored.statusCode, 200, workspaceRestored.body);
    assert.equal(workspaceRestored.json().data.recipe.archived, false);

    const blockedSubmitKey = randomUUID();
    const blockedSubmit = await familyOwner.request('POST', `/api/v1/recipe-workspace/${workspaceRecipeId}/submit`, {
        expectedVersion: 5,
        idempotencyKey: blockedSubmitKey,
    });
    assert.equal(blockedSubmit.statusCode, 403, blockedSubmit.body);
    assert.equal(blockedSubmit.json().error.code, 'DISSEMINATION_CONSENT_REQUIRED');
    assert.deepEqual(blockedSubmit.json().error.details.action, {
        href: '/settings/privacy',
        label: 'Ознакомиться и согласиться',
    });
    assert.equal(
        (await pool.query(`select count(*)::int count from meal.idempotency_records where key=$1`, [blockedSubmitKey]))
            .rows[0].count,
        0,
    );
    const disseminationDocument = registrationDocument('dissemination');
    const acceptWorkspaceConsent = async (expectedRevision) => {
        const response = await familyOwner.request('POST', '/api/v1/settings/legal-consents/dissemination/accept', {
            accepted: true,
            document: disseminationDocument,
            expectedRevision,
            idempotencyKey: randomUUID(),
        });
        assert.equal(response.statusCode, 200, response.body);
        return response;
    };
    const revokeWorkspaceConsent = async (expectedRevision) => {
        const response = await familyOwner.request('POST', '/api/v1/settings/legal-consents/dissemination/revoke', {
            expectedRevision,
            idempotencyKey: randomUUID(),
        });
        assert.equal(response.statusCode, 200, response.body);
        return response;
    };
    await acceptWorkspaceConsent(0);
    const workspaceSubmitted = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/submit`,
        { expectedVersion: 5, idempotencyKey: blockedSubmitKey },
    );
    assert.equal(workspaceSubmitted.statusCode, 200, workspaceSubmitted.body);
    assert.equal(workspaceSubmitted.json().data.recipe.status, 'pending');
    assert.equal(workspaceSubmitted.json().data.recipe.version, 6);

    const familyWorkspaceCreate = await familyOwner.request('POST', '/api/v1/recipe-workspace', {
        idempotencyKey: randomUUID(),
        scope: 'family',
        document: workspaceDocument('Exact family recipe'),
    });
    assert.equal(familyWorkspaceCreate.statusCode, 200, familyWorkspaceCreate.body);
    const familyWorkspaceRecipeId = familyWorkspaceCreate.json().data.recipe.id;
    const familyMemberWorkspaceDetail = await familyMember.request(
        'GET',
        `/api/v1/recipe-workspace/${familyWorkspaceRecipeId}?scope=family`,
    );
    assert.equal(familyMemberWorkspaceDetail.statusCode, 200, familyMemberWorkspaceDetail.body);
    assert.equal(familyMemberWorkspaceDetail.json().data.recipe.canEdit, false);
    assert.equal(
        (
            await familyMember.request('PUT', `/api/v1/recipe-workspace/${familyWorkspaceRecipeId}`, {
                expectedVersion: 1,
                idempotencyKey: randomUUID(),
                document: workspaceDocument('Member cannot edit'),
            })
        ).statusCode,
        404,
    );
    assert.equal(
        (await familyOutsider.request('GET', `/api/v1/recipe-workspace/${familyWorkspaceRecipeId}?scope=family`))
            .statusCode,
        404,
    );

    const workspaceVariantPayload = { idempotencyKey: randomUUID() };
    const workspaceVariant = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/variant`,
        workspaceVariantPayload,
    );
    assert.equal(workspaceVariant.statusCode, 200, workspaceVariant.body);
    assert.equal(workspaceVariant.json().data.recipe.baseRecipeId, workspaceRecipeId);
    assert.equal(workspaceVariant.json().data.recipe.availabilityScope, 'private');
    const workspaceVariantReplay = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/variant`,
        workspaceVariantPayload,
    );
    assert.equal(workspaceVariantReplay.statusCode, 200, workspaceVariantReplay.body);
    assert.deepEqual(workspaceVariantReplay.json().data, workspaceVariant.json().data);

    const missingEvidenceKey = randomUUID();
    const missingCookingEvidence = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/rating`,
        { idempotencyKey: missingEvidenceKey, attemptId: randomUUID(), value: 5, confirmed: true },
    );
    assert.equal(missingCookingEvidence.statusCode, 403, missingCookingEvidence.body);
    assert.equal(
        (
            await pool.query(`select count(*)::int count from meal.idempotency_records where key=$1`, [
                missingEvidenceKey,
            ])
        ).rows[0].count,
        0,
    );

    const workspaceState = await ownerPool.query(
        `select r.scope_id,rr.id revision_id from meal.recipes r
         join lateral(select id from meal.recipe_revisions where recipe_id=r.id order by revision desc limit 1) rr on true
         where r.id=$1`,
        [workspaceRecipeId],
    );
    const workspaceAttemptId = randomUUID();
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.cooking_attempts(
               id,status,started_at,completed_at,recipe_snapshot,output_snapshot,
               confirmed_duration,private_note,scope_id,actor_id,revision_id
             ) values($1,'completed',now()-interval '2 hours',now()-interval '1 hour',$2::jsonb,'{}'::jsonb,60,null,$3,$4,$5)`,
            [
                workspaceAttemptId,
                JSON.stringify({
                    recipeId: workspaceRecipeId,
                    revisionId: workspaceState.rows[0].revision_id,
                    title: 'Exact private recipe',
                    servings: 2,
                    method: 'Приёмочный способ',
                    steps: [{ position: 0, text: 'Проверить транзакционный результат', durationSeconds: 60 }],
                }),
                workspaceState.rows[0].scope_id,
                familyOwner.userId,
                workspaceState.rows[0].revision_id,
            ],
        );
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    const initialWorkspaceCommunity = await familyOwner.request(
        'GET',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/community`,
    );
    assert.equal(initialWorkspaceCommunity.statusCode, 200, initialWorkspaceCommunity.body);
    assert.equal(initialWorkspaceCommunity.json().data.attemptId, workspaceAttemptId);
    assert.equal(initialWorkspaceCommunity.json().data.rating, null);

    await revokeWorkspaceConsent(1);
    const blockedRatingKey = randomUUID();
    const blockedRating = await familyOwner.request('POST', `/api/v1/recipe-workspace/${workspaceRecipeId}/rating`, {
        idempotencyKey: blockedRatingKey,
        attemptId: workspaceAttemptId,
        value: 5,
        confirmed: true,
    });
    assert.equal(blockedRating.statusCode, 403, blockedRating.body);
    assert.equal(blockedRating.json().error.code, 'DISSEMINATION_CONSENT_REQUIRED');
    assert.equal(
        (await pool.query(`select count(*)::int count from meal.idempotency_records where key=$1`, [blockedRatingKey]))
            .rows[0].count,
        0,
    );
    await acceptWorkspaceConsent(2);
    const workspaceRatingPayload = {
        idempotencyKey: blockedRatingKey,
        attemptId: workspaceAttemptId,
        value: 5,
        confirmed: true,
    };
    const workspaceRating = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/rating`,
        workspaceRatingPayload,
    );
    assert.equal(workspaceRating.statusCode, 200, workspaceRating.body);
    const workspaceRatingReplay = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/rating`,
        workspaceRatingPayload,
    );
    assert.equal(workspaceRatingReplay.statusCode, 200, workspaceRatingReplay.body);
    assert.deepEqual(workspaceRatingReplay.json().data, workspaceRating.json().data);
    assert.equal(
        (
            await familyOwner.request('POST', `/api/v1/recipe-workspace/${workspaceRecipeId}/rating`, {
                ...workspaceRatingPayload,
                value: 4,
            })
        ).statusCode,
        409,
    );

    const workspaceCommentPayload = {
        idempotencyKey: randomUUID(),
        attemptId: workspaceAttemptId,
        body: 'Exact community comment',
        replyToId: null,
    };
    const workspaceComment = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/comments`,
        workspaceCommentPayload,
    );
    assert.equal(workspaceComment.statusCode, 200, workspaceComment.body);
    const workspaceCommentId = workspaceComment.json().data.id;
    const workspaceCommentReplay = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/comments`,
        workspaceCommentPayload,
    );
    assert.equal(workspaceCommentReplay.statusCode, 200, workspaceCommentReplay.body);
    assert.deepEqual(workspaceCommentReplay.json().data, workspaceComment.json().data);
    const workspaceCommentEdit = await familyOwner.request(
        'PATCH',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/comments/${workspaceCommentId}`,
        { expectedVersion: 1, idempotencyKey: randomUUID(), body: 'Exact community comment edited' },
    );
    assert.equal(workspaceCommentEdit.statusCode, 200, workspaceCommentEdit.body);
    assert.equal(
        (
            await familyOwner.request(
                'PATCH',
                `/api/v1/recipe-workspace/${workspaceRecipeId}/comments/${workspaceCommentId}`,
                { expectedVersion: 1, idempotencyKey: randomUUID(), body: 'Stale community edit' },
            )
        ).statusCode,
        409,
    );
    const workspaceCommentRemoved = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/comments/${workspaceCommentId}/remove`,
        { expectedVersion: 2, idempotencyKey: randomUUID() },
    );
    assert.equal(workspaceCommentRemoved.statusCode, 200, workspaceCommentRemoved.body);

    const workspaceReportPayload = {
        idempotencyKey: randomUUID(),
        reason: 'quality',
        comment: 'Exact non-critical report',
        commentId: null,
    };
    const workspaceReport = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/reports`,
        workspaceReportPayload,
    );
    assert.equal(workspaceReport.statusCode, 200, workspaceReport.body);
    const workspaceReportId = workspaceReport.json().data.id;
    const workspaceReportReplay = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/reports`,
        workspaceReportPayload,
    );
    assert.equal(workspaceReportReplay.statusCode, 200, workspaceReportReplay.body);
    assert.deepEqual(workspaceReportReplay.json().data, workspaceReport.json().data);
    assert.equal(
        (
            await familyOwner.request('POST', `/api/v1/recipe-workspace/${workspaceRecipeId}/reports`, {
                ...workspaceReportPayload,
                reason: 'fake',
            })
        ).statusCode,
        409,
    );
    const criticalComment = await familyOwner.request(
        'POST',
        `/api/v1/recipe-workspace/${workspaceRecipeId}/comments`,
        {
            idempotencyKey: randomUUID(),
            attemptId: workspaceAttemptId,
            body: 'Comment hidden by a critical report',
            replyToId: null,
        },
    );
    assert.equal(criticalComment.statusCode, 200, criticalComment.body);
    const criticalReport = await familyOwner.request('POST', `/api/v1/recipe-workspace/${workspaceRecipeId}/reports`, {
        idempotencyKey: randomUUID(),
        reason: 'personal-data',
        comment: 'Immediate hiding branch',
        commentId: criticalComment.json().data.id,
    });
    assert.equal(criticalReport.statusCode, 200, criticalReport.body);
    const workspaceReports = await familyOwner.request('GET', '/api/v1/recipe-workspace/reports?page=1&limit=10');
    assert.equal(workspaceReports.statusCode, 200, workspaceReports.body);
    assert.equal(
        workspaceReports.json().data.items.some((item) => item.id === workspaceReportId),
        true,
    );
    const workspaceReportDetail = await familyOwner.request(
        'GET',
        `/api/v1/recipe-workspace/reports/${workspaceReportId}`,
    );
    assert.equal(workspaceReportDetail.statusCode, 200, workspaceReportDetail.body);
    assert.equal(workspaceReportDetail.json().data.id, workspaceReportId);
    assert.equal(
        (await familyOutsider.request('GET', `/api/v1/recipe-workspace/reports/${workspaceReportId}`)).statusCode,
        404,
    );

    const workspaceEffects = await pool.query(
        `select
           (select count(*)::int from meal.recipes where id in($1,$2,$3)) recipes,
           (select count(*)::int from meal.recipe_revisions where recipe_id=$1) revisions,
           (select count(*)::int from meal.moderation_cases where reporter_id=$4 and kind='recipe' and recipe_revision_id in(select id from meal.recipe_revisions where recipe_id=$1)) submissions,
           (select count(*)::int from meal.recipe_ratings where recipe_id=$1 and user_id=$4) ratings,
           (select count(*)::int from meal.recipe_comments where id=$5 and removed_at is not null and version=3) removed_comments,
           (select count(*)::int from meal.comment_revisions where comment_id=$5) comment_revisions,
           (select count(*)::int from meal.moderation_cases where id=$6 and reporter_id=$4 and kind='report') reports,
           (select count(*)::int from meal.moderation_decisions where case_id=$9 and action='auto_hide') critical_decisions,
           (select count(*)::int from meal.recipe_comments where id=$10 and removed_at is not null) critically_hidden_comments,
           (select count(*)::int from meal.idempotency_records where user_id=$4 and operation like 'recipe.%') idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$4 and target_type='recipe-workspace') audits,
           (select count(*)::int from meal.idempotency_records where user_id=$4 and key=$7) blocked_submit_records,
           (select count(*)::int from meal.idempotency_records where user_id=$4 and key=$8) blocked_rating_records`,
        [
            workspaceRecipeId,
            familyWorkspaceRecipeId,
            workspaceVariant.json().data.recipe.id,
            familyOwner.userId,
            workspaceCommentId,
            workspaceReportId,
            blockedSubmitKey,
            blockedRatingKey,
            criticalReport.json().data.id,
            criticalComment.json().data.id,
        ],
    );
    assert.deepEqual(workspaceEffects.rows[0], {
        recipes: 3,
        revisions: 3,
        submissions: 1,
        ratings: 1,
        removed_comments: 1,
        comment_revisions: 2,
        reports: 1,
        critical_decisions: 1,
        critically_hidden_comments: 1,
        idempotency: 15,
        audits: 15,
        blocked_submit_records: 1,
        blocked_rating_records: 1,
    });
    console.log(
        `RECIPE_WORKSPACE_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'recipe-workspace-live-v1',
            operationIds: [
                'RecipeWorkspaceController_reportDetail',
                'RecipeWorkspaceController_reports',
                'RecipeWorkspaceController_list',
                'RecipeWorkspaceController_create',
                'RecipeWorkspaceController_detail',
                'RecipeWorkspaceController_save',
                'RecipeWorkspaceController_archive',
                'RecipeWorkspaceController_restore',
                'RecipeWorkspaceController_submit',
                'RecipeWorkspaceController_rollback',
                'RecipeWorkspaceController_variant',
                'RecipeWorkspaceController_community',
                'RecipeWorkspaceController_rating',
                'RecipeWorkspaceController_comment',
                'RecipeWorkspaceController_editComment',
                'RecipeWorkspaceController_removeComment',
                'RecipeWorkspaceController_report',
            ],
            effects: workspaceEffects.rows[0],
            assertions: {
                exactResponses: true,
                databaseEffects: true,
                auditAndImmutableHistory: true,
                idempotentReplayAndAlteredPayload: true,
                staleCasRollback: true,
                privateAndFamilyIdor: true,
                freePrivateAndPlusFamily: true,
                disseminationRevokeAndRegrant: true,
                consentFailuresRollbackBeforeIdempotency: true,
                cookingEvidenceRequired: true,
                nonCriticalReportPreservesRecipe: true,
                criticalReportHidesTargetAndRecordsDecision: true,
            },
        })}`,
    );

    await runAiProDomainAcceptance({
        app,
        pool,
        ownerPool,
        headers,
        userId,
        sessionId: secondUserSessionId,
        suffix,
        privateScopeId,
        ingredientId: largeTenantIngredientId,
        inventoryBatchId: createdBatch.id,
        recipeId: publicRecipe.recipeId,
        revisionId: publicRecipe.revisionId,
        authorUsername: familyOwner.username,
        familyId,
        familyRecipient: familyOwner,
        familyDonor: familyMember,
        personalizationService: app.get(PersonalizationService),
    });

    await runRemainingDomainsAcceptance({
        app,
        pool,
        ownerPool,
        headers,
        adminHeaders: adminAcceptanceHeaders,
        userId,
        privateScopeId,
        ingredientId: largeTenantIngredientId,
        unitId: largeTenantUnitId,
        recipeId: publicRecipe.recipeId,
        revisionId: publicRecipe.revisionId,
        authorUsername: familyOwner.username,
        familyOwner,
        familyMember,
        registerVerifiedAccount,
        subscriptionSettingsService: app.get(SubscriptionSettingsService),
        suffix,
    });

    const accountClient = await newAccountClient();
    const accountAddress = `account-v2-${suffix}@example.test`;
    const accountUsername = `accountv2_${suffix}`.slice(0, 30);
    const registerV2Payload = {
        username: accountUsername,
        displayName: 'Account V2 Exact',
        email: accountAddress,
        password: accountPassword,
        legal: registrationLegal,
    };
    const registerV2WithoutCsrf = await accountClient.request('POST', '/api/v1/auth/register/v2', registerV2Payload, {
        csrf: false,
    });
    assert.equal(registerV2WithoutCsrf.statusCode, 403, registerV2WithoutCsrf.body);
    assert.equal(
        Number(
            (await pool.query('select count(*) from meal.users where email_normalized=$1', [accountAddress])).rows[0]
                .count,
        ),
        0,
    );
    const registerV2 = await accountClient.request('POST', '/api/v1/auth/register/v2', registerV2Payload);
    assert.equal(registerV2.statusCode, 200, registerV2.body);
    assert.deepEqual(registerV2.json().data, { accepted: true });
    await ageAccountRateLimits();
    const resend = await accountClient.request('POST', '/api/v1/auth/email/resend', { email: accountAddress });
    assert.equal(resend.statusCode, 200, resend.body);
    const accountVerifyToken = await mailboxToken(accountClient, accountAddress, 'verify');
    assert.equal(
        (await accountClient.request('POST', '/api/v1/auth/email/verify', { token: accountVerifyToken })).statusCode,
        200,
    );
    const accountLogin = await accountClient.request('POST', '/api/v1/auth/login', {
        email: accountAddress,
        password: accountPassword,
    });
    assert.equal(accountLogin.statusCode, 200, accountLogin.body);
    const accountUserId = accountLogin.json().data.user.id;
    const securityInitial = await accountClient.request('GET', '/api/v1/auth/security');
    assert.equal(securityInitial.statusCode, 200, securityInitial.body);
    assert.deepEqual(securityInitial.json().data, {
        authenticatorEnabled: false,
        pinEnabled: false,
        pendingEmail: null,
    });
    const pinSetup = await accountClient.request('POST', '/api/v1/auth/pin/setup', {
        password: accountPassword,
        pin: '654321',
    });
    assert.equal(pinSetup.statusCode, 200, pinSetup.body);
    assert.equal(pinSetup.json().data.enabled, true);
    assert.match(accountClient.jar.get('meal_device') ?? '', /^[A-Za-z0-9_-]{43}$/);
    accountClient.jar.delete('meal_user');
    const pinLogin = await accountClient.request('POST', '/api/v1/auth/pin/login', { pin: '654321' });
    assert.equal(pinLogin.statusCode, 200, pinLogin.body);
    assert.equal(pinLogin.json().data.user.id, accountUserId);
    const securityWithPin = await accountClient.request('GET', '/api/v1/auth/security');
    assert.equal(securityWithPin.json().data.pinEnabled, true);
    const pinRevoke = await accountClient.request('POST', '/api/v1/auth/pin/revoke', {});
    assert.equal(pinRevoke.statusCode, 200, pinRevoke.body);
    assert.deepEqual(pinRevoke.json().data, { revoked: true });
    assert.equal((await accountClient.request('GET', '/api/v1/auth/security')).json().data.pinEnabled, false);

    const authenticatorSetup = await accountClient.request('POST', '/api/v1/auth/authenticator/setup', {
        password: accountPassword,
    });
    assert.equal(authenticatorSetup.statusCode, 200, authenticatorSetup.body);
    const factorSecret = authenticatorSetup.json().data.enrollment.secret;
    const factorCode = generateSync({
        secret: factorSecret,
        period: 30,
        digits: 6,
        epoch: Math.floor(Date.now() / 1000),
    });
    const authenticatorConfirm = await accountClient.request('POST', '/api/v1/auth/authenticator/confirm', {
        challenge: authenticatorSetup.json().data.challenge,
        code: factorCode,
    });
    assert.equal(authenticatorConfirm.statusCode, 200, authenticatorConfirm.body);
    assert.equal(authenticatorConfirm.json().data.recoveryCodes.length, 10);
    assert.equal((await accountClient.request('GET', '/api/v1/auth/security')).json().data.authenticatorEnabled, true);
    const firstRecoveryCode = authenticatorConfirm.json().data.recoveryCodes[0];
    accountClient.jar.delete('meal_user');
    const totpLogin = await accountClient.request('POST', '/api/v1/auth/totp/login', {
        email: accountAddress,
        code: generateSync({
            secret: factorSecret,
            period: 30,
            digits: 6,
            epoch: Math.floor(Date.now() / 1000) + 30,
        }),
    });
    assert.equal(totpLogin.statusCode, 200, totpLogin.body);
    assert.equal(totpLogin.json().data.user.id, accountUserId);
    const regenerated = await accountClient.request('POST', '/api/v1/auth/authenticator/recovery-codes', {
        password: accountPassword,
        proof: { method: 'recovery', code: firstRecoveryCode },
    });
    assert.equal(regenerated.statusCode, 200, regenerated.body);
    assert.equal(regenerated.json().data.recoveryCodes.length, 10);
    assert.equal(regenerated.json().data.recoveryCodes.includes(firstRecoveryCode), false);

    const changedAddress = `account-v2-changed-${suffix}@example.test`;
    const emailChange = await accountClient.request('POST', '/api/v1/auth/email/change', {
        email: changedAddress,
        password: accountPassword,
    });
    assert.equal(emailChange.statusCode, 200, emailChange.body);
    const emailConfirmToken = await mailboxToken(accountClient, changedAddress, 'email-confirm');
    const emailCancelToken = await mailboxToken(accountClient, accountAddress, 'email-cancel');
    const emailConfirm = await accountClient.request('POST', '/api/v1/auth/email/change/confirm', {
        token: emailConfirmToken,
    });
    assert.equal(emailConfirm.statusCode, 200, emailConfirm.body);
    assert.match(emailConfirm.json().data.effectiveAt, /^\d{4}-\d{2}-\d{2}T/);
    const pendingSecurity = await accountClient.request('GET', '/api/v1/auth/security');
    assert.equal(pendingSecurity.json().data.pendingEmail.email, changedAddress);
    assert.equal(pendingSecurity.json().data.pendingEmail.confirmed, true);
    const emailCancel = await accountClient.request('POST', '/api/v1/auth/email/change/cancel', {
        token: emailCancelToken,
    });
    assert.equal(emailCancel.statusCode, 200, emailCancel.body);
    assert.deepEqual(emailCancel.json().data, { cancelled: true });
    assert.equal((await accountClient.request('GET', '/api/v1/auth/security')).json().data.pendingEmail, null);

    const finalPassword = 'AccountExactPassword2!';
    const passwordChange = await accountClient.request('POST', '/api/v1/auth/password/change', {
        currentPassword: accountPassword,
        password: finalPassword,
    });
    assert.equal(passwordChange.statusCode, 200, passwordChange.body);
    assert.deepEqual(passwordChange.json().data, { changed: true });
    assert.equal(
        (
            await accountClient.request('POST', '/api/v1/auth/login', {
                email: accountAddress,
                password: accountPassword,
            })
        ).statusCode,
        401,
    );
    assert.equal(
        (
            await accountClient.request('POST', '/api/v1/auth/login', {
                email: accountAddress,
                password: finalPassword,
            })
        ).statusCode,
        200,
    );

    const resetClient = await registerVerifiedAccount('resetexact');
    await ageAccountRateLimits();
    const recovery = await resetClient.request('POST', '/api/v1/auth/password/recovery', {
        email: resetClient.address,
    });
    assert.equal(recovery.statusCode, 200, recovery.body);
    const resetToken = await mailboxToken(resetClient, resetClient.address, 'reset');
    assert.equal(
        (await resetClient.request('POST', '/api/v1/auth/password/reset/check', { token: resetToken })).statusCode,
        200,
    );
    const resetPassword = 'AccountResetPassword2!';
    const reset = await resetClient.request('POST', '/api/v1/auth/password/reset', {
        token: resetToken,
        password: resetPassword,
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(
        (
            await resetClient.request('POST', '/api/v1/auth/password/reset', {
                token: resetToken,
                password: 'AccountResetPassword3!',
            })
        ).statusCode,
        400,
    );

    const issueLifecycleReauth = async (client) => {
        const response = await client.request('POST', '/api/v1/account/critical-reauth', {
            purpose: 'account_lifecycle',
            password: accountPassword,
            factor: null,
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.match(response.json().data.reauthToken, /^[A-Za-z0-9_-]{43}$/);
        return response.json().data.reauthToken;
    };
    const deletionClient = await registerVerifiedAccount('deletionexact');
    const lifecycleInitial = await deletionClient.request('GET', '/api/v1/account/lifecycle');
    assert.equal(lifecycleInitial.statusCode, 200, lifecycleInitial.body);
    assert.deepEqual(lifecycleInitial.json().data, { archived: false, deletion: null });
    const deletionPreview = await deletionClient.request('GET', '/api/v1/account/deletion/preview');
    assert.equal(deletionPreview.statusCode, 200, deletionPreview.body);
    assert.equal(deletionPreview.json().data.canRequest, true);
    assert.equal(deletionPreview.json().data.canFinalize, false);
    const deletionKey = randomUUID();
    const deletionPayload = {
        reauthToken: await issueLifecycleReauth(deletionClient),
        idempotencyKey: deletionKey,
        acknowledgement: true,
    };
    const deletionRequest = await deletionClient.request('POST', '/api/v1/account/deletion', deletionPayload);
    assert.equal(deletionRequest.statusCode, 202, deletionRequest.body);
    const deletionReplay = await deletionClient.request('POST', '/api/v1/account/deletion', deletionPayload);
    assert.equal(deletionReplay.statusCode, 202, deletionReplay.body);
    assert.deepEqual(deletionReplay.json().data, deletionRequest.json().data);
    const deletionState = await deletionClient.request('GET', '/api/v1/account/lifecycle');
    assert.equal(deletionState.json().data.deletion.id, deletionRequest.json().data.id);
    const cancelPayload = {
        reauthToken: await issueLifecycleReauth(deletionClient),
        expectedVersion: deletionRequest.json().data.version,
    };
    const cancelled = await deletionClient.request('POST', '/api/v1/account/deletion/cancel', cancelPayload);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().data.status, 'cancelled');
    assert.equal(cancelled.json().data.version, deletionRequest.json().data.version + 1);

    const archiveClient = await registerVerifiedAccount('archiveexact');
    const archiveSessionId = archiveClient.sessionId;
    const archiveKey = randomUUID();
    const archivePayload = { reauthToken: await issueLifecycleReauth(archiveClient), idempotencyKey: archiveKey };
    const archived = await archiveClient.request('POST', '/api/v1/account/archive', archivePayload, { cookies: false });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.deepEqual(archived.json().data, { archived: true });
    const archiveReplay = await archiveClient.request('POST', '/api/v1/account/archive', archivePayload, {
        cookies: false,
    });
    assert.equal(archiveReplay.statusCode, 401, archiveReplay.body);
    const foreignArchive = await deletionClient.request('POST', '/api/v1/account/archive', archivePayload);
    assert.equal(foreignArchive.statusCode, 401, foreignArchive.body);

    const retentionPolicyId = randomUUID();
    const retentionPolicy = {
        version: `acceptance-${suffix}`,
        graceDays: 1,
        accountDataDays: 0,
        paymentDocuments: { mode: 'retain', days: 365 },
        supportHistory: { mode: 'retain', days: 365 },
        auditHistory: { mode: 'retain', days: 365 },
        backups: { mode: 'expire_by_rotation', maxDays: 30 },
        sharedFamilyHistory: 'retain_pseudonymized',
    };
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.feature_rule_versions(id,key,version,enabled,rules,effective_at,changed_by)
             values($1,'account_deletion_retention',1,true,$2::jsonb,now()-interval '1 day',$3)`,
            [retentionPolicyId, JSON.stringify(retentionPolicy), userId],
        );
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    const finalizeClient = await registerVerifiedAccount('finalizeexact');
    const finalizeRequest = await finalizeClient.request('POST', '/api/v1/account/deletion', {
        reauthToken: await issueLifecycleReauth(finalizeClient),
        idempotencyKey: randomUUID(),
        acknowledgement: true,
    });
    assert.equal(finalizeRequest.statusCode, 202, finalizeRequest.body);
    await ownerPool.query('begin isolation level serializable');
    try {
        const fastForwarded = await ownerPool.query(
            `update meal.legal_requests set requested_at=now()-interval '2 days' where id=$1`,
            [finalizeRequest.json().data.id],
        );
        assert.equal(fastForwarded.rowCount, 1);
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    await setAdminCriticalUntil(new Date(Date.now() + 5 * 60_000));
    const reviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/account-deletions/${finalizeRequest.json().data.id}/review`,
        headers: criticalAdminHeaders,
        payload: {
            decision: 'approve',
            expectedVersion: finalizeRequest.json().data.version,
            reason: 'Exact acceptance approval',
        },
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.json().data.status, 'ready');
    const blockedFinalize = await finalizeClient.request('POST', '/api/v1/account/deletion/finalize', {
        reauthToken: await issueLifecycleReauth(finalizeClient),
        expectedVersion: reviewed.json().data.version,
    });
    assert.equal(blockedFinalize.statusCode, 200, blockedFinalize.body);
    assert.equal(blockedFinalize.json().data.status, 'blocked');
    assert.equal(blockedFinalize.json().data.version, reviewed.json().data.version + 1);
    assert.ok(
        blockedFinalize
            .json()
            .data.blockers.some(
                (blocker) => blocker.code === 'export_not_ready' && blocker.blocksFinalization === true,
            ),
    );
    const blockedEffects = await pool.query(
        `select
           (select status from meal.users where id=$1) user_status,
           (select export_id from meal.legal_requests where id=$2) export_id,
           (select count(*)::int from meal.audit_events where actor_id=$1 and action='account.deletion.blocked') blocked_audits`,
        [finalizeClient.userId, finalizeRequest.json().data.id],
    );
    assert.deepEqual(blockedEffects.rows[0], {
        user_status: 'active',
        export_id: null,
        blocked_audits: 1,
    });

    const exportAssetId = randomUUID();
    const exportJobId = randomUUID();
    const exportIdempotencyKey = randomUUID();
    const exportManifest = {
        schemaVersion: '2026-10-09',
        selection: {
            scope: 'private',
            domain: 'personal_data',
            format: 'json',
            startsOn: null,
            endsOn: null,
        },
        scopeId: null,
        familyId: null,
        requesterId: finalizeClient.userId,
        sections: [
            {
                code: 'identity',
                label: 'Учётная запись',
                detail: 'Идентификаторы и основные данные учётной записи.',
                ownership: 'requester',
            },
        ],
        exclusions: [],
        aclSnapshotAt: new Date().toISOString(),
        proAccess: null,
    };
    await ownerPool.query('begin isolation level serializable');
    try {
        await ownerPool.query(
            `insert into meal.media_assets(id,object_key,mime,size_bytes,checksum,status,retention_class,uploader_id)
             values($1,$2,'application/json',2,$3,'ready','account_export',$4)`,
            [
                exportAssetId,
                `acceptance/account-export/${exportAssetId}.json`,
                `sha256:${'0'.repeat(64)}`,
                finalizeClient.userId,
            ],
        );
        await ownerPool.query(
            `insert into meal.export_jobs(id,kind,format,period,status,manifest,requested_at,expires_at,user_id,file_id,idempotency_key)
             values($1,'personal_data','json',$2,'ready',$3::jsonb,now(),now()+interval '1 day',$4,$5,$6)`,
            [
                exportJobId,
                JSON.stringify({ startsOn: null, endsOn: null }),
                JSON.stringify({
                    exportManifest,
                    completedAt: new Date().toISOString(),
                    failureCode: null,
                    idempotencyKey: exportIdempotencyKey,
                }),
                finalizeClient.userId,
                exportAssetId,
                exportIdempotencyKey,
            ],
        );
        await ownerPool.query('commit');
    } catch (error) {
        await ownerPool.query('rollback');
        throw error;
    }
    await setAdminCriticalUntil(new Date(Date.now() + 5 * 60_000));
    const rereviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/account-deletions/${finalizeRequest.json().data.id}/review`,
        headers: criticalAdminHeaders,
        payload: {
            decision: 'approve',
            expectedVersion: blockedFinalize.json().data.version,
            reason: 'Exact acceptance export verification',
        },
    });
    assert.equal(rereviewed.statusCode, 200, rereviewed.body);
    assert.equal(rereviewed.json().data.status, 'ready');
    assert.equal(rereviewed.json().data.version, blockedFinalize.json().data.version + 1);
    assert.equal(
        (await pool.query(`select export_id from meal.legal_requests where id=$1`, [finalizeRequest.json().data.id]))
            .rows[0].export_id,
        exportJobId,
    );
    const finalizeReauthToken = await issueLifecycleReauth(finalizeClient);
    const finalized = await finalizeClient.request('POST', '/api/v1/account/deletion/finalize', {
        reauthToken: finalizeReauthToken,
        expectedVersion: rereviewed.json().data.version,
    });
    if (finalized.statusCode === 500) {
        try {
            await app
                .get(AccountLifecycleService)
                .finalizeDeletion(
                    finalizeClient.userId,
                    finalizeClient.sessionId,
                    finalizeReauthToken,
                    rereviewed.json().data.version,
                    randomUUID(),
                );
        } catch (error) {
            const classification =
                error && typeof error === 'object' && 'code' in error
                    ? `${String(error.code)}:${'constraint' in error ? String(error.constraint) : ''}:${'message' in error ? String(error.message).slice(0, 200) : ''}`
                    : (error?.constructor?.name ?? 'UnknownError');
            throw new Error(`AccountLifecycleController_finalize: ${classification}`);
        }
    }
    assert.equal(finalized.statusCode, 200, finalized.body);
    assert.equal(finalized.json().data.status, 'finalized');

    const accountEffects = await pool.query(
        `select
           (select count(*)::int from meal.users where id=$1) users,
           ((select count(*)::int from meal.agreement_acceptance_events where user_id=$1 and agreement_kind='offer' and action='accepted' and evidence_mode='demonstration') +
            (select count(*)::int from meal.legal_acknowledgement_events where user_id=$1 and document_kind='privacy_notice' and action='acknowledged' and evidence_mode='demonstration')) registration_evidence,
           (select count(*)::int from meal.account_devices where user_id=$1 and revoked_at is not null) revoked_devices,
           (select count(*)::int from meal.mfa_factors where user_id=$1 and verified_at is not null and revoked_at is null) active_factors,
           (select count(*)::int from meal.mfa_recovery_codes c where c.factor_id in(select id from meal.mfa_factors where user_id=$1 and revoked_at is null) and c.used_at is null and c.generation=(select max(latest.generation) from meal.mfa_recovery_codes latest where latest.factor_id=c.factor_id)) recovery_codes,
           (select count(*)::int from meal.account_email_changes where user_id=$1 and cancelled_at is not null) cancelled_email_changes,
           (select count(*)::int from meal.audit_events where actor_id=$1 and action like 'account.%') account_audits,
           (select count(*)::int from meal.legal_requests where user_id=$2 and kind='account_deletion') deletion_requests,
           (select count(*)::int from meal.audit_events where actor_id=$2 and action in('account.critical_reauth.issued','account.deletion.requested','account.deletion.cancelled')) deletion_audits,
           (select count(*)::int from meal.idempotency_records where user_id=$3 and operation='account.archive') archive_idempotency,
           (select count(*)::int from meal.audit_events where actor_id=$3 and action='account.archived') archive_audits,
           (select count(*)::int from meal.sessions where id=$4 and revoked_at is not null) archive_session_revoked,
           (select status from meal.users where id=$3) archive_status,
           (select status from meal.users where id=$5) finalized_status,
           (select count(*)::int from meal.audit_events where actor_id=$5 and action='account.deletion.blocked') blocked_finalize_audits,
           (select count(*)::int from meal.audit_events where actor_id=$5 and action='account.deletion.finalized') finalized_audits,
           (select count(*)::int from meal.sessions where user_id=$5 and revoked_at is null) finalized_active_sessions`,
        [accountUserId, deletionClient.userId, archiveClient.userId, archiveSessionId, finalizeClient.userId],
    );
    assert.deepEqual(accountEffects.rows[0], {
        users: 1,
        registration_evidence: 2,
        revoked_devices: 1,
        active_factors: 1,
        recovery_codes: 10,
        cancelled_email_changes: 1,
        account_audits: 11,
        deletion_requests: 1,
        deletion_audits: 4,
        archive_idempotency: 1,
        archive_audits: 1,
        archive_session_revoked: 1,
        archive_status: 'archived',
        finalized_status: 'deleted',
        blocked_finalize_audits: 1,
        finalized_audits: 1,
        finalized_active_sessions: 0,
    });
    console.log(
        `ACCOUNT_LIFECYCLE_ACCEPTANCE_EVIDENCE ${JSON.stringify({
            schema: 'account-lifecycle-live-v1',
            operationIds: [
                'AccountController_registerV2',
                'AccountController_resend',
                'AccountController_recovery',
                'AccountController_resetCheck',
                'AccountController_reset',
                'AccountController_passwordChange',
                'AccountController_emailChange',
                'AccountController_emailConfirm',
                'AccountController_emailCancel',
                'AccountController_totpLogin',
                'AccountController_pinSetup',
                'AccountController_pinLogin',
                'AccountController_pinRevoke',
                'AccountController_security',
                'AccountController_authenticatorSetup',
                'AccountController_authenticatorConfirm',
                'AccountController_recoveryCodes',
                'AccountLifecycleController_confirm',
                'AccountLifecycleController_state',
                'AccountLifecycleController_archive',
                'AccountLifecycleController_preview',
                'AccountLifecycleController_requestDeletion',
                'AccountLifecycleController_cancel',
                'AccountLifecycleController_finalize',
                'AdminAccountLifecycleController_review',
            ],
            effects: accountEffects.rows[0],
            assertions: {
                exactResponses: true,
                databaseEffects: true,
                auditEffects: true,
                blockedFinalizePersistsAndAudits: true,
                readyExportRequiredAndLinked: true,
                tokenReplayRollback: true,
                requestDeletionIdempotency: true,
                archiveRevokesSessionBeforePublicReplay: true,
                productionSmtpSuccessCovered: false,
                tokenDeliveryAdapter: 'development-mailbox',
            },
        })}`,
    );

    const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: headers(),
        payload: {},
        remoteAddress: '198.27.0.1',
    });
    assert.equal(logout.statusCode, 200, logout.body);
    for (const cookie of logout.cookies) cookies.set(cookie.name, cookie.value);
    assert.equal(
        (
            await app.inject({
                method: 'GET',
                url: '/api/v1/auth/me',
                headers: { cookie: headers().cookie },
                remoteAddress: '198.27.0.1',
            })
        ).statusCode,
        401,
    );

    const effects = await pool.query(
        `select u.email_verified_at is not null as verified,
          count(distinct s.id)::int as sessions,
          bool_and(s.revoked_at is not null) as sessions_revoked,
          count(distinct a.id)::int as audit_events
         from meal.users u
         left join meal.sessions s on s.user_id=u.id and s.kind='user'
         left join meal.audit_events a on a.actor_id=u.id
         where u.email_normalized=$1
         group by u.id`,
        [email],
    );
    assert.equal(effects.rows[0]?.verified, true);
    assert.equal(effects.rows[0]?.sessions, 2);
    assert.equal(effects.rows[0]?.sessions_revoked, true);
    assert.ok(effects.rows[0]?.audit_events >= 4);
    console.log(
        `Live PostgreSQL acceptance passed: schema, grants, account lifecycle, Free/Plus/Pro/former-Pro gates, consent revoke/regrant, moderator case claim/skip/decision and support replay/reopen/revocation, ${authenticatedAdminReads} authenticated admin reads (${JSON.stringify(Object.fromEntries(adminReadStatuses))}), ${authenticatedReads} authenticated user reads (${JSON.stringify(Object.fromEntries(statuses))}), ${authenticatedMutations} role-aware mutation boundaries (${JSON.stringify(Object.fromEntries(mutationStatuses))}), isolated admin/user logout and local performance ${JSON.stringify(performanceResults)}`,
    );
} catch (error) {
    console.log(
        `ACCEPTANCE_FAILURE ${JSON.stringify({
            name: error?.name ?? 'Error',
            code: error?.code ?? null,
            constraint: error?.constraint ?? null,
            message: String(error?.message ?? error).slice(0, 500),
            stack: String(error?.stack ?? '')
                .split('\n')
                .slice(0, 10),
        })}`,
    );
    process.exitCode = 1;
} finally {
    await app?.close();
    await pool.end();
    await ownerPool.end();
}
