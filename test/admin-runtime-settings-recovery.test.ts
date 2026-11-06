import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runtimeSettingsTabSchema } from '../src/modules/admin-runtime-settings/public.js';

void test('runtime settings exposes a separate recovery-key tab without secret material', async () => {
    assert.equal(runtimeSettingsTabSchema.safeParse('backup_recovery').success, true);
    const source = await readFile('src/modules/admin-runtime-settings/admin-runtime-settings.service.ts', 'utf8');
    assert.match(source, /\['backup_recovery', 'Recovery-доступ'\]/);
    assert.match(source, /key: 'local-backup-recovery-access'/);
    assert.match(source, /\/etc\/meal-planner\/secrets\/local-backup-password/);
    assert.match(source, /\/var\/backups\/meal-planner\/local-restic/);
    assert.match(source, /Bitwarden, 1Password/);
    assert.match(source, /не может подтвердить независимую копию/);
    assert.match(source, /Не редактируйте password file вручную/);
    assert.match(source, /fingerprint: null/);
    assert.doesNotMatch(source, /recoveryPasswordValue|passwordValue|secretValue/);
});
