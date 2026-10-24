import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicProfileSchema, publicProjection } from '../src/modules/profiles/profiles.schemas.js';
import { createApp } from '../src/app/create-app.js';
import { readConfig } from '../src/app/config.js';

await test('public projection rejects private fields and does not invent domain counters', () => {
    const profile = publicProjection('user1');
    assert.equal(profile.recipeCount, null);
    assert.equal(profile.achievements, null);
    assert.equal(publicProfileSchema.safeParse({ ...profile, email: 'private@example.test' }).success, false);
    assert.equal(publicProfileSchema.safeParse({ ...profile, displayName: 'Private' }).success, false);
});
await test('profile endpoints fail safely without a configured database', async () => {
    const app = await createApp(readConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    try {
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/authors/user1' })).statusCode, 503);
        assert.equal((await app.inject({ method: 'GET', url: '/api/v1/profile' })).statusCode, 503);
    } finally {
        await app.close();
    }
});
await test('profile update has only the reviewed least-privilege columns', () => {
    const grants = readFileSync(new URL('../../database/application-grants.sql', import.meta.url), 'utf8');
    assert.match(grants, /GRANT UPDATE \(display_name\) ON meal\.users TO meal_app;/);
    assert.match(grants, /GRANT INSERT ON meal\.user_settings TO meal_app;/);
    assert.match(
        grants,
        /GRANT UPDATE \(timezone,locale,theme,onboarding_state,preferences,version\) ON meal\.user_settings TO meal_app;/,
    );
    assert.doesNotMatch(grants, /GRANT (?:SELECT,)?INSERT,UPDATE ON meal\.users/);
});
