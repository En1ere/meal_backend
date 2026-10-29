import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.ACCEPTANCE_OWNER_DATABASE_URL;
if (!connectionString) throw new Error('Set ACCEPTANCE_OWNER_DATABASE_URL for isolated account-mail acceptance');
const target = new URL(connectionString);
if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(target.hostname) ||
    target.pathname !== '/meal_planner_postgres' ||
    decodeURIComponent(target.username) !== 'meal_owner'
)
    throw new Error('Account-mail acceptance requires local meal_owner@meal_planner_postgres');

const client = new pg.Client({ connectionString, options: '-c timezone=UTC -c search_path=meal,public' });
const userId = randomUUID();
const tokenId = randomUUID();
const deliveryId = randomUUID();
const leaseToken = randomUUID();
const attemptId = randomUUID();
const messageId = `<${deliveryId}@transactional.meal-planner.invalid>`;

try {
    await client.connect();
    await client.query('begin isolation level serializable');
    await client.query('set local role meal_app');
    await client.query(
        `insert into meal.users(id,login,display_name,email_normalized,status)
         values($1,$2,'Mail acceptance',$3,'active')`,
        [userId, `mail-${userId}`, `${userId}@example.test`],
    );
    await client.query(
        `insert into meal.account_tokens
           (id,user_id,kind,token_hash,token_ciphertext,email_target,expires_at,cipher_key_version)
         values($1,$2,'reset',$3,'acceptance-ciphertext',$4,now()+interval '1 hour',2)`,
        [tokenId, userId, `hash-${tokenId}`, `${userId}@example.test`],
    );
    await client.query(
        `insert into meal.account_mail_deliveries
           (id,account_token_id,user_id,recipient,kind,status,message_id)
         values($1,$2,$3,$4,'reset','queued',$5)`,
        [deliveryId, tokenId, userId, `${userId}@example.test`, messageId],
    );

    await client.query('set local role meal_mail_worker');
    const boundary = await client.query(`select
      has_table_privilege(current_user,'meal.account_mail_deliveries','SELECT') as delivery_read,
      has_table_privilege(current_user,'meal.account_tokens','SELECT') as token_read,
      has_table_privilege(current_user,'meal.password_credentials','SELECT') as credentials_read,
      has_table_privilege(current_user,'meal.sessions','SELECT') as sessions_read`);
    assert.deepEqual(boundary.rows[0], {
        delivery_read: true,
        token_read: true,
        credentials_read: false,
        sessions_read: false,
    });
    await client.query(
        `update meal.account_mail_deliveries set
           status='processing',attempts=1,lease_owner='acceptance',lease_token=$2,
           lease_until=now()+interval '2 minutes',updated_at=now(),version=version+1
         where id=$1`,
        [deliveryId, leaseToken],
    );
    await client.query(
        `insert into meal.account_mail_attempts
           (id,delivery_id,attempt_no,outcome,message_id,started_at,finished_at)
         values($1,$2,1,'accepted',$3,now(),now())`,
        [attemptId, deliveryId, messageId],
    );
    await client.query(
        `update meal.account_mail_deliveries set
           status='accepted',lease_owner=null,lease_token=null,lease_until=null,
           provider_reference='acceptance-provider',accepted_at=now(),completed_at=now(),
           updated_at=now(),version=version+1
         where id=$1 and status='processing' and lease_token=$2`,
        [deliveryId, leaseToken],
    );
    const result = await client.query(
        `select d.status,d.attempts,count(a.id)::int as recorded_attempts
         from meal.account_mail_deliveries d
         left join meal.account_mail_attempts a on a.delivery_id=d.id
         where d.id=$1 group by d.id`,
        [deliveryId],
    );
    assert.deepEqual(result.rows[0], { status: 'accepted', attempts: 1, recorded_attempts: 1 });
    await client.query('rollback');
    console.log('Account-mail live PostgreSQL acceptance: enqueue, worker boundary and terminal delivery PASS');
} catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
} finally {
    await client.end().catch(() => undefined);
}
