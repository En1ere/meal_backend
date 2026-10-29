import assert from 'node:assert/strict';
import test from 'node:test';
import { moderatorActionsForStatus } from '../src/modules/moderator/moderator.service.js';

void test('moderator decisions expose only state-compatible actions', () => {
    assert.deepEqual(moderatorActionsForStatus('queued'), ['approve', 'reject']);
    assert.deepEqual(moderatorActionsForStatus('in_review'), ['approve', 'reject']);
    assert.deepEqual(moderatorActionsForStatus('pending'), ['approve', 'reject']);
    assert.deepEqual(moderatorActionsForStatus('approved'), ['publish', 'reject']);
    assert.deepEqual(moderatorActionsForStatus('published'), ['hide', 'unpublish']);
    for (const terminal of ['rejected', 'hide', 'unpublish', 'closed', 'deleted'])
        assert.deepEqual(moderatorActionsForStatus(terminal), []);
});
