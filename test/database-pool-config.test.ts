import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databasePoolConfig } from '../src/infrastructure/database/database.service.js';

void test('database startup options preserve the least-privilege SET ROLE contract', () => {
    const config = databasePoolConfig(
        'postgresql://meal_runtime:secret@postgres/meal_planner_postgres?options=-c%20role%3Dmeal_app',
    );
    assert.equal(config.connectionString.includes('options='), false);
    assert.match(config.options, /-c role=meal_app/);
    assert.match(config.options, /-c timezone=UTC/);
    assert.match(config.options, /-c search_path=meal,public/);
});
