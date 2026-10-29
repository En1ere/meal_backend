import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/app/config.js';

const fixture = (name: string) => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));

void test('production secrets can be loaded from absolute Docker secret files', () => {
    const config = readConfig({
        NODE_ENV: 'production',
        FRONTEND_ORIGIN: 'https://meal.example.test',
        ADMIN_FRONTEND_ORIGIN: 'https://admin.meal.example.test',
        DATABASE_URL_FILE: fixture('database-url.txt'),
        SECURITY_KEY_FILE: fixture('security-key.txt'),
        MFA_ENCRYPTION_KEY_FILE: fixture('mfa-key.txt'),
    });
    assert.equal(config.DATABASE_URL?.includes('meal_runtime'), true);
    assert.equal(config.SECURITY_KEY?.length, 44);
    assert.equal(config.MFA_ENCRYPTION_KEY?.length, 44);
    assert.throws(
        () =>
            readConfig({
                DATABASE_URL: 'postgresql://meal_app:test@localhost/meal_planner_postgres',
                DATABASE_URL_FILE: fixture('database-url.txt'),
            }),
        /either DATABASE_URL or DATABASE_URL_FILE/,
    );
    assert.throws(() => readConfig({ SECURITY_KEY_FILE: 'relative-secret' }), /absolute path/);
});
