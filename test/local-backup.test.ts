import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const text = (path: string) => readFile(path, 'utf8');

void test('local backup is encrypted, bounded, locked and keeps the agreed policy', async () => {
    const script = await text('deploy/local-backup.sh');
    assert.match(script, /REPOSITORY=\/var\/backups\/meal-planner\/local-restic/);
    assert.match(script, /local-backup-password/);
    assert.match(script, /restic backup --json --tag meal-local-daily/);
    assert.match(script, /restic check/);
    assert.match(script, /--keep-daily 7 --keep-weekly 4 --prune/);
    assert.match(script, /take_lock/);
    assert.match(script, /meal-planner-local-backup\.lock/);
    assert.match(script, /MIN_FREE_BYTES=5368709120/);
    assert.match(script, /MIN_FREE_PERCENT=20/);
    assert.match(script, /staging_required_bytes=\$\(\(MIN_FREE_BYTES \+ database_bytes\)\)/);
    assert.match(script, /MEDIA_STORAGE_ENABLED|media_storage_enabled/);
    assert.match(script, /compose stop -t 120 seaweedfs/);
    assert.match(script, /policy:\{rpoSeconds:86400,rtoSeconds:14400,offsite:false\}/);
    assert.match(script, /recoveryKeyConfigured:\$recoveryKeyConfigured/);
    assert.match(script, /artifact_count=\$stage_count/);
    assert.doesNotMatch(script, /artifact_count=\$\(\(stage_count \+ media_count\)\)/);
    assert.match(script, /FRONTEND_IMAGE=%s\\nADMIN_IMAGE=%s/);
    assert.match(script, /chown root:meal-observability "\$temporary"/);
    assert.match(script, /mv -f "\$temporary" "\$STATUS_FILE"/);
    assert.doesNotMatch(script, /\/etc\/meal-planner\/secrets["' ]+\$STAGING/);
});

void test('timer is persistent and uses 01:00 Asia/Yekaterinburg exactly', async () => {
    const timer = await text('deploy/systemd/meal-local-backup.timer');
    assert.match(timer, /OnCalendar=\*-\*-\* 01:00:00 Asia\/Yekaterinburg/);
    assert.match(timer, /Persistent=true/);
    assert.match(timer, /RandomizedDelaySec=0/);
});

void test('status writer keeps the bounded admin reader contract', async () => {
    const script = await text('deploy/local-backup.sh');
    assert.match(script, /\{schemaVersion:1,state:\$state,observedAt:\$observedAt,lastAttemptAt:\$lastAttemptAt/);
    assert.match(script, /lastSuccessAt:\$lastSuccessAt,snapshotId:\$snapshotId,snapshotAt:\$snapshotAt/);
    assert.match(script, /repositoryBytes:\$repositoryBytes,artifactCount:\$artifactCount/);
    assert.match(script, /schedule:\{timezone:"Asia\/Yekaterinburg",localTime:"01:00"\}/);
    assert.match(script, /retention:\{daily:7,weekly:4\}/);
    assert.match(script, /restoreDrill:\$restoreDrill/);
    assert.match(script, /failureCode:\(if \$failureCode=="" then null else \$failureCode end\)/);
});

void test('backup unit exposes only the recovery key and fixed writable paths', async () => {
    const unit = await text('deploy/systemd/meal-local-backup.service');
    assert.match(unit, /PrivateNetwork=true/);
    assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
    assert.match(unit, /InaccessiblePaths=\/etc\/meal-planner\/secrets/);
    assert.match(unit, /BindReadOnlyPaths=\/etc\/meal-planner\/secrets\/local-backup-password:/);
    assert.match(unit, /RuntimeDirectory=meal-local-backup/);
    assert.match(unit, /CacheDirectory=meal-planner-restic/);
    assert.match(unit, /Environment=RESTIC_CACHE_DIR=\/var\/cache\/meal-planner-restic/);
    assert.match(unit, /ReadWritePaths=\/var\/backups\/meal-planner\/local-restic/);
    assert.match(unit, /TimeoutStartSec=2h/);
});

void test('restore drill is exact, isolated, disposable and checks manifest-bound schema invariants', async () => {
    const drill = await text('deploy/local-backup-restore-drill.sh');
    assert.match(drill, /--snapshot must be an exact restic snapshot ID/);
    assert.match(drill, /--network none/);
    assert.match(drill, /--tmpfs \/var\/lib\/postgresql/);
    assert.match(drill, /pg_restore --exit-on-error --single-transaction --no-owner --no-acl/);
    assert.match(drill, /migration-manifest\.json/);
    assert.match(drill, /\.migrations\|length/);
    assert.match(drill, /generate_series\(1,\$expected_migration_count\)/);
    assert.match(drill, /\[ "\$facts" = "\$expected_facts\/t" \]/);
    assert.match(drill, /elapsed.*14400/s);
    assert.match(drill, /source_unchanged=true/);
    assert.match(drill, /docker rm -f/);
    assert.match(drill, /require_file "\$STATUS_FILE"/);
    assert.match(drill, /if \$outcome=="passed" then \.state else "failed" end/);
    assert.match(drill, /if \$outcome=="passed" then \.failureCode else \$failureCode end/);
});

void test('bootstrap never overwrites a recovery password and does not run a backup implicitly', async () => {
    const bootstrap = await text('deploy/bootstrap-local-backup.sh');
    assert.match(bootstrap, /if \[ ! -e "\$PASSWORD_FILE" \]/);
    assert.match(bootstrap, /openssl rand -base64 48/);
    assert.match(bootstrap, /Existing \/etc\/meal-planner\/secrets bootstrap is required/);
    assert.doesNotMatch(bootstrap, /install -d[^\n]+dirname "\$PASSWORD_FILE"/);
    assert.match(bootstrap, /systemctl enable --now meal-local-backup\.timer/);
    assert.doesNotMatch(bootstrap, /systemctl start meal-local-backup\.service/);
});
