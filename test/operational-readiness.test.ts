import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    operationalExternalBlockers,
    operationalReadiness,
} from '../src/modules/operational-runtime/operational-readiness.js';

const manifest = {
    database: 'meal_planner_postgres',
    postgresMajor: 18,
    schemaVersion: 29,
    totalTables: 209,
    foreignKeys: 483,
};

void test('operational readiness exposes implemented lease and telemetry as capabilities', () => {
    const readiness = operationalReadiness(manifest);
    assert.equal(readiness.capabilities.sharedLeaseBackend.status, 'ready');
    assert.equal(readiness.capabilities.telemetryAndAlertSink.status, 'ready');
    assert.deepEqual(readiness.blockers, operationalExternalBlockers);
    assert.ok(!readiness.blockers.includes('shared_lease_backend' as never));
    assert.ok(!readiness.blockers.includes('telemetry_and_alert_sink' as never));
});

void test('operational readiness rejects a schema without shared leases', () => {
    assert.throws(() => operationalReadiness({ ...manifest, schemaVersion: 23 }), /shared worker lease schema/);
});
