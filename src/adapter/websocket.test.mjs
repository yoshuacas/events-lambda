import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { AppSyncWebSocketClient } from './websocket.mjs';

/**
 * Minimal mock WebSocket that emits open, message, close,
 * error events and captures send() calls.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this._listeners = {};
  }

  addEventListener(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
  }

  removeEventListener(event, handler) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(
      (h) => h !== handler
    );
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._emit('close', { code: 1000, reason: '' });
  }

  // Test helpers

  _emit(event, data) {
    const handlers = this._listeners[event] || [];
    for (const handler of handlers) {
      handler(data);
    }
  }

  _open() {
    this.readyState = MockWebSocket.OPEN;
    this._emit('open', {});
  }

  _receiveMessage(data) {
    this._emit('message', { data: JSON.stringify(data) });
  }
}

describe('AppSyncWebSocketClient', () => {
  let client;
  let wsInstance;
  let wsFactory;

  beforeEach(() => {
    wsInstance = null;
    wsFactory = class extends MockWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        wsInstance = this;
      }
    };

    client = new AppSyncWebSocketClient({
      httpUrl: 'example.com',
      wsUrl: 'wss://example.com',
      token: 'my-jwt',
      WebSocket: wsFactory,
    });
  });

  it('connect uses correct URL format', async () => {
    const connectPromise = client.connect();
    // Open the WebSocket to complete connection
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    assert.ok(
      wsInstance.url.startsWith('wss://example.com/event/realtime'),
      `expected URL to start with wss://example.com/event/realtime, got ${wsInstance.url}`
    );
  });

  it('connect includes aws-appsync-event-ws subprotocol', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    assert.ok(
      wsInstance.protocols.includes('aws-appsync-event-ws'),
      'expected aws-appsync-event-ws in subprotocols'
    );
  });

  it('connect includes base64url-encoded auth subprotocol', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const headerProto = wsInstance.protocols.find((p) =>
      p.startsWith('header-')
    );
    assert.ok(headerProto, 'expected a header-... subprotocol');

    // Decode the base64url portion and verify it contains host
    // and Authorization
    const encoded = headerProto.slice('header-'.length);
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    );
    assert.ok(decoded.host, 'expected host in decoded header');
    assert.ok(decoded.Authorization, 'expected Authorization in decoded header');
  });

  it('connection_init is sent after WebSocket opens', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const initMsg = wsInstance.sent.find((raw) => {
      const msg = JSON.parse(raw);
      return msg.type === 'connection_init';
    });
    assert.ok(initMsg, 'expected connection_init message to be sent');
  });

  it('connection_ack is handled and timeout stored', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    assert.equal(client.connectionTimeoutMs, 300000);
  });

  it('ka messages reset keepalive timer', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    // Record the initial keepalive state, then send ka
    const beforeKa = client._lastKeepalive;
    wsInstance._receiveMessage({ type: 'ka' });
    const afterKa = client._lastKeepalive;

    assert.ok(
      afterKa >= beforeKa,
      'expected keepalive timestamp to be refreshed'
    );
  });

  it('subscribe sends correct message format', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    // Find the subscribe message
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    assert.ok(subMsg, 'expected subscribe message');
    assert.equal(subMsg.type, 'subscribe');
    assert.ok(subMsg.id, 'expected unique id');
    assert.equal(subMsg.channel, '/db/public/messages/INSERT');
    assert.ok(subMsg.authorization, 'expected authorization object');

    // Resolve the subscribe
    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;
  });

  it('subscribe_success resolves the subscribe promise', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });

    // Should resolve without error
    await subPromise;
  });

  it('subscribe_error rejects the subscribe promise', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_error',
      id: subMsg.id,
      errors: [{ message: 'Unauthorized' }],
    });

    await assert.rejects(() => subPromise);
  });

  it('data messages are routed to subscription callbacks', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const cb = mock.fn();
    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      cb
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;

    // Deliver a data message
    wsInstance._receiveMessage({
      type: 'data',
      id: subMsg.id,
      event: [JSON.stringify({ eventType: 'INSERT' })],
    });

    assert.equal(cb.mock.calls.length, 1);
    assert.deepEqual(cb.mock.calls[0].arguments[0], { eventType: 'INSERT' });
  });

  it('data messages with multiple events invoke callback per event', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const cb = mock.fn();
    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      cb
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;

    // Deliver a data message with two events
    wsInstance._receiveMessage({
      type: 'data',
      id: subMsg.id,
      event: [
        JSON.stringify({ eventType: 'INSERT', id: '1' }),
        JSON.stringify({ eventType: 'INSERT', id: '2' }),
      ],
    });

    assert.equal(cb.mock.calls.length, 2);
  });

  it('wildcard subscription extracts eventType from payload', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const cb = mock.fn();
    const subPromise = client.subscribe(
      '/db/public/messages/*',
      'my-jwt',
      cb
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;

    wsInstance._receiveMessage({
      type: 'data',
      id: subMsg.id,
      event: [JSON.stringify({ eventType: 'INSERT', id: '1' })],
    });

    assert.equal(cb.mock.calls.length, 1);
    // Verify the callback receives the correct eventType value
    // from the payload, not derived from the channel name
    assert.equal(cb.mock.calls[0].arguments[0].eventType, 'INSERT');
  });

  it('publish sends correct message format (broadcast)', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const events = [{ event: 'typing', payload: { user: 'alice' }, type: 'broadcast' }];
    const pubPromise = client.publish(
      '/broadcast/room1/typing',
      events,
      'my-jwt'
    );

    const pubMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'publish');

    assert.ok(pubMsg, 'expected publish message');
    assert.equal(pubMsg.channel, '/broadcast/room1/typing');
    assert.ok(Array.isArray(pubMsg.events), 'expected events array');
    assert.equal(typeof pubMsg.events[0], 'string');
    assert.ok(pubMsg.authorization, 'expected authorization object');

    wsInstance._receiveMessage({
      type: 'publish_success',
      id: pubMsg.id,
    });
    await pubPromise;
  });

  it('publish_success resolves the publish promise', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const pubPromise = client.publish(
      '/broadcast/room1/typing',
      [{ x: 1 }],
      'my-jwt'
    );
    const pubMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'publish');

    wsInstance._receiveMessage({
      type: 'publish_success',
      id: pubMsg.id,
    });

    await pubPromise;
  });

  it('unsubscribe sends correct message', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;

    client.unsubscribe(subMsg.id);

    const unsubMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'unsubscribe');

    assert.ok(unsubMsg, 'expected unsubscribe message');
    assert.equal(unsubMsg.id, subMsg.id);
  });

  it('unsubscribe_success cleans up subscription state', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const cb = mock.fn();
    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      cb
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });
    await subPromise;

    client.unsubscribe(subMsg.id);
    wsInstance._receiveMessage({
      type: 'unsubscribe_success',
      id: subMsg.id,
    });

    // Sending data for the old subscription should not invoke callback
    wsInstance._receiveMessage({
      type: 'data',
      id: subMsg.id,
      event: [JSON.stringify({ eventType: 'INSERT' })],
    });

    assert.equal(
      cb.mock.calls.length,
      0,
      'callback should not be invoked after unsubscribe_success'
    );
  });

  it('multiple subscriptions share single WebSocket', async () => {
    const connectPromise = client.connect();
    const firstWs = wsInstance;
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const sub1Promise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    const sub2Promise = client.subscribe(
      '/db/public/users/INSERT',
      'my-jwt',
      () => {}
    );

    const subMsgs = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .filter((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsgs[0].id,
    });
    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsgs[1].id,
    });

    await sub1Promise;
    await sub2Promise;

    // The same WebSocket instance is used (connect is idempotent)
    assert.strictEqual(
      wsInstance,
      firstWs,
      'expected single WebSocket instance'
    );
  });

  it('subscribe resolves with the subscription ID', async () => {
    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    const subPromise = client.subscribe(
      '/db/public/messages/INSERT',
      'my-jwt',
      () => {}
    );
    const subMsg = wsInstance.sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.type === 'subscribe');

    wsInstance._receiveMessage({
      type: 'subscribe_success',
      id: subMsg.id,
    });

    const subId = await subPromise;
    assert.equal(subId, subMsg.id, 'subscribe should resolve with the subscription ID');
    assert.ok(subId, 'subscription ID should not be undefined');
  });

  it('connect rejects when WebSocket emits error before connection_ack', async () => {
    const connectPromise = client.connect();

    // Emit error before connection_ack
    wsInstance._emit('error', new Error('Connection refused'));

    await assert.rejects(
      () => connectPromise,
      'expected connect to reject on WebSocket error'
    );
  });

  it('connect is idempotent when already connected', async () => {
    const connectPromise1 = client.connect();
    const firstWs = wsInstance;
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise1;

    // Second connect should reuse the same connection
    const connectPromise2 = client.connect();
    await connectPromise2;

    assert.strictEqual(
      wsInstance,
      firstWs,
      'expected the same WebSocket instance to be reused'
    );
  });

  it('concurrent connect calls share a single WebSocket', async () => {
    const connectPromise1 = client.connect();
    const connectPromise2 = client.connect();
    const firstWs = wsInstance;

    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });

    await Promise.all([connectPromise1, connectPromise2]);

    assert.strictEqual(
      wsInstance,
      firstWs,
      'concurrent connects should not create a second WebSocket'
    );
  });

  it('connection-level error triggers error handler', async () => {
    const errorHandler = mock.fn();
    client.onError(errorHandler);

    const connectPromise = client.connect();
    wsInstance._open();
    wsInstance._receiveMessage({
      type: 'connection_ack',
      connectionTimeoutMs: 300000,
    });
    await connectPromise;

    wsInstance._receiveMessage({ type: 'error' });

    assert.ok(
      errorHandler.mock.calls.length > 0,
      'expected error handler to be invoked'
    );
  });
});
