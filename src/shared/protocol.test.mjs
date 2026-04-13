import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSegment,
  pgChangesChannel,
  broadcastChannel,
  presenceChannel,
} from './protocol.mjs';

describe('sanitizeSegment', () => {
  it('maps underscores to dashes', () => {
    assert.equal(sanitizeSegment('user_profiles'), 'user-profiles');
  });

  it('accepts alphanumeric and dash unchanged', () => {
    assert.equal(sanitizeSegment('my-channel'), 'my-channel');
  });

  it('rejects dots', () => {
    assert.throws(
      () => sanitizeSegment('hello.world'),
      {
        message: /contains characters not allowed in AppSync channel segments/,
      }
    );
  });

  it('rejects other special characters', () => {
    assert.throws(
      () => sanitizeSegment('hello@world'),
      {
        message: /contains characters not allowed in AppSync channel segments/,
      }
    );
  });

  it('rejects segments exceeding 50 characters', () => {
    assert.throws(
      () => sanitizeSegment('a'.repeat(51)),
      {
        message: /exceeds 50-character AppSync segment limit/,
      }
    );
  });

  it('accepts exactly 50 characters', () => {
    const input = 'a'.repeat(50);
    assert.equal(sanitizeSegment(input), input);
  });
});

describe('pgChangesChannel', () => {
  it('builds correct path', () => {
    assert.equal(
      pgChangesChannel('public', 'messages', 'INSERT'),
      '/db/public/messages/INSERT'
    );
  });

  it('maps underscores in table name', () => {
    assert.equal(
      pgChangesChannel('public', 'user_profiles', 'INSERT'),
      '/db/public/user-profiles/INSERT'
    );
  });

  it('supports wildcard event', () => {
    assert.equal(
      pgChangesChannel('public', 'messages', '*'),
      '/db/public/messages/*'
    );
  });
});

describe('broadcastChannel', () => {
  it('builds correct path', () => {
    assert.equal(
      broadcastChannel('room1', 'cursor-move'),
      '/broadcast/room1/cursor-move'
    );
  });

  it('maps underscores in channel name', () => {
    assert.equal(
      broadcastChannel('my_room', 'typing'),
      '/broadcast/my-room/typing'
    );
  });
});

describe('presenceChannel', () => {
  it('builds correct path', () => {
    assert.equal(presenceChannel('room1'), '/presence/room1');
  });
});
