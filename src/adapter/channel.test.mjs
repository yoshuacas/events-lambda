import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeChannel, createRealtimeAdapter } from './channel.mjs';

describe('RealtimeChannel', () => {
  let mockWsClient;
  let adapter;

  beforeEach(() => {
    mockWsClient = {
      connect: mock.fn(() => Promise.resolve()),
      subscribe: mock.fn((channel, token, cb) => {
        // Return a subscription ID
        const id = `sub-${mockWsClient.subscribe.mock.calls.length}`;
        return Promise.resolve(id);
      }),
      unsubscribe: mock.fn(() => Promise.resolve()),
      publish: mock.fn(() => Promise.resolve()),
      onError: mock.fn(),
    };

    adapter = createRealtimeAdapter({
      httpUrl: 'example.com',
      wsUrl: 'wss://example.com',
      token: 'my-jwt',
      _wsClient: mockWsClient,
    });
  });

  it('on postgres_changes registers subscription to correct channel', () => {
    const channel = adapter.channel('test');
    const cb = mock.fn();
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      cb
    );

    // Check internal listener targets the correct channel
    const listeners = channel._listeners || channel.listeners;
    const target = listeners.find(
      (l) => l.channel === '/db/public/messages/INSERT'
    );
    assert.ok(
      target,
      'expected listener targeting /db/public/messages/INSERT'
    );
  });

  it('on postgres_changes with wildcard event registers wildcard channel', () => {
    const channel = adapter.channel('test');
    const cb = mock.fn();
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages' },
      cb
    );

    const listeners = channel._listeners || channel.listeners;
    const target = listeners.find(
      (l) => l.channel === '/db/public/messages/*'
    );
    assert.ok(
      target,
      'expected listener targeting /db/public/messages/*'
    );
  });

  it('on broadcast registers subscription to correct channel', () => {
    const channel = adapter.channel('room1');
    const cb = mock.fn();
    channel.on('broadcast', { event: 'cursor-move' }, cb);

    const listeners = channel._listeners || channel.listeners;
    const target = listeners.find(
      (l) => l.channel === '/broadcast/room1/cursor-move'
    );
    assert.ok(
      target,
      'expected listener targeting /broadcast/room1/cursor-move'
    );
  });

  it('subscribe opens WebSocket and sends subscribe messages', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );
    channel.on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages' },
      () => {}
    );

    await channel.subscribe();

    assert.ok(
      mockWsClient.connect.mock.calls.length >= 1,
      'expected WebSocket connect to be called'
    );
    assert.equal(
      mockWsClient.subscribe.mock.calls.length,
      2,
      'expected two subscribe calls'
    );
  });

  it('subscribe callback receives SUBSCRIBED on success', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );

    const statusCb = mock.fn();
    await channel.subscribe(statusCb);

    const subscribedCall = statusCb.mock.calls.find(
      (call) => call.arguments[0] === 'SUBSCRIBED'
    );
    assert.ok(subscribedCall, 'expected SUBSCRIBED status callback');
  });

  it('subscribe callback receives CHANNEL_ERROR on failure', async () => {
    mockWsClient.subscribe.mock.mockImplementation(() =>
      Promise.reject(new Error('subscribe_error'))
    );

    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );

    const statusCb = mock.fn();
    await channel.subscribe(statusCb);

    const errorCall = statusCb.mock.calls.find(
      (call) => call.arguments[0] === 'CHANNEL_ERROR'
    );
    assert.ok(errorCall, 'expected CHANNEL_ERROR status callback');
  });

  it('send broadcast publishes to correct channel', async () => {
    const channel = adapter.channel('room1');
    channel.on('broadcast', { event: 'cursor-move' }, () => {});
    await channel.subscribe();

    await channel.send({
      type: 'broadcast',
      event: 'cursor-move',
      payload: { x: 1 },
    });

    assert.equal(mockWsClient.publish.mock.calls.length, 1);
    const [publishChannel] =
      mockWsClient.publish.mock.calls[0].arguments;
    assert.equal(
      publishChannel,
      '/broadcast/room1/cursor-move',
      'expected publish to /broadcast/room1/cursor-move'
    );
  });

  it('unsubscribe sends unsubscribe for all subscriptions', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );
    channel.on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages' },
      () => {}
    );

    await channel.subscribe();
    await channel.unsubscribe();

    assert.equal(
      mockWsClient.unsubscribe.mock.calls.length,
      2,
      'expected two unsubscribe calls'
    );
  });

  it('subscribe is idempotent', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );

    await channel.subscribe();
    await channel.subscribe();

    assert.equal(
      mockWsClient.subscribe.mock.calls.length,
      1,
      'expected only one subscribe call (idempotent)'
    );
  });

  it('incoming data is routed to correct callback', async () => {
    const channel = adapter.channel('test');
    const messagesCb = mock.fn();
    const usersCb = mock.fn();

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      messagesCb
    );
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'users' },
      usersCb
    );

    await channel.subscribe();

    // Simulate data arriving for the messages subscription
    // The callback for 'messages' should fire but not 'users'
    const messagesSubId =
      mockWsClient.subscribe.mock.calls[0].result ||
      (await mockWsClient.subscribe.mock.calls[0].result);

    // Trigger the messages callback via the ws client's
    // registered callback
    const messagesCallback =
      mockWsClient.subscribe.mock.calls[0].arguments[2];
    messagesCallback({
      eventType: 'INSERT',
      new: { id: '1' },
    });

    assert.equal(
      messagesCb.mock.calls.length,
      1,
      'messages callback should fire'
    );
    assert.equal(
      usersCb.mock.calls.length,
      0,
      'users callback should NOT fire'
    );
  });

  it('multiple on() listeners produce separate subscriptions', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages' },
      () => {}
    );
    channel.on('broadcast', { event: 'typing' }, () => {});

    await channel.subscribe();

    assert.equal(
      mockWsClient.subscribe.mock.calls.length,
      3,
      'expected three separate subscribe calls'
    );

    // Verify distinct subscription IDs
    const ids = mockWsClient.subscribe.mock.calls.map(
      (call) => call.arguments[0]
    );
    const uniqueIds = new Set(ids);
    assert.equal(
      uniqueIds.size,
      3,
      'expected three distinct channel paths'
    );
  });

  it('on postgres_changes with table containing underscores', () => {
    const channel = adapter.channel('test');
    const cb = mock.fn();
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'user_profiles' },
      cb
    );

    const listeners = channel._listeners || channel.listeners;
    const target = listeners.find(
      (l) => l.channel === '/db/public/user-profiles/INSERT'
    );
    assert.ok(
      target,
      'expected listener targeting /db/public/user-profiles/INSERT'
    );
  });

  it('createRealtimeAdapter returns object with channel method', () => {
    const channel = adapter.channel('test');
    assert.ok(typeof channel.on === 'function', 'expected on method');
    assert.ok(
      typeof channel.subscribe === 'function',
      'expected subscribe method'
    );
    assert.ok(typeof channel.send === 'function', 'expected send method');
    assert.ok(
      typeof channel.unsubscribe === 'function',
      'expected unsubscribe method'
    );
  });

  it('removeChannel unsubscribes and cleans up', async () => {
    const channel = adapter.channel('test');
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      () => {}
    );
    await channel.subscribe();

    adapter.removeChannel(channel);

    assert.ok(
      mockWsClient.unsubscribe.mock.calls.length >= 1,
      'expected unsubscribe to be called'
    );
  });

  it('broadcast event name with invalid characters is rejected', async () => {
    const channel = adapter.channel('room1');
    channel.on('broadcast', { event: 'bad.event' }, () => {});

    try {
      await channel.subscribe();
      // If subscribe does not throw, check for CHANNEL_ERROR
      // via a status callback approach
      assert.fail(
        'expected an error for invalid broadcast event name'
      );
    } catch (err) {
      assert.match(
        err.message,
        /contains characters not allowed in AppSync channel segments/
      );
    }
  });

  it('broadcast event name exceeding 50 characters is rejected', async () => {
    const channel = adapter.channel('room1');
    channel.on('broadcast', { event: 'a'.repeat(51) }, () => {});

    try {
      await channel.subscribe();
      assert.fail(
        'expected an error for broadcast event name exceeding 50 chars'
      );
    } catch (err) {
      assert.match(
        err.message,
        /exceeds 50-character AppSync segment limit/
      );
    }
  });

  it('broadcast channel name with invalid characters is rejected', async () => {
    const channel = adapter.channel('bad.room');
    channel.on('broadcast', { event: 'typing' }, () => {});

    try {
      await channel.subscribe();
      assert.fail(
        'expected an error for invalid channel name'
      );
    } catch (err) {
      assert.match(
        err.message,
        /contains characters not allowed in AppSync channel segments/
      );
    }
  });

  it('broadcast send rejects payload exceeding 240 KB', async () => {
    const channel = adapter.channel('room1');
    channel.on('broadcast', { event: 'big' }, () => {});
    await channel.subscribe();

    await channel.send({
      type: 'broadcast',
      event: 'big',
      payload: { data: 'x'.repeat(250000) },
    });

    assert.equal(
      mockWsClient.publish.mock.calls.length,
      0,
      'expected publish to NOT be called for oversized payload'
    );
  });

  it('broadcast channel name with underscores maps to dashes', () => {
    const channel = adapter.channel('my_room');
    const cb = mock.fn();
    channel.on('broadcast', { event: 'typing' }, cb);

    const listeners = channel._listeners || channel.listeners;
    const target = listeners.find(
      (l) => l.channel === '/broadcast/my-room/typing'
    );
    assert.ok(
      target,
      'expected listener targeting /broadcast/my-room/typing'
    );
  });
});
