# Adapter API Reference

The adapter runs in the browser (or Node.js) and translates `@supabase/supabase-js` realtime API calls into AppSync Events WebSocket subscriptions.

## createRealtimeAdapter(config)

Returns an object that plugs into `@supabase/supabase-js` as the `realtime` option.

```javascript
import { createRealtimeAdapter } from 'events-lambda/adapter';

const adapter = createRealtimeAdapter({
  httpUrl: 'example.appsync-api.us-east-1.amazonaws.com',
  wsUrl: 'wss://example.appsync-realtime-api.us-east-1.amazonaws.com',
  token: cognitoIdToken,
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `httpUrl` | string | Yes | AppSync Events HTTP domain. Used in auth headers. From SAM output `RealtimeHttpEndpoint`. |
| `wsUrl` | string | Yes | AppSync Events WebSocket domain. Must use `wss://` scheme. From SAM output `RealtimeWsEndpoint`. |
| `token` | string | No | Cognito JWT for authentication. Passed to subscribe and publish operations. |
| `_wsClient` | AppSyncWebSocketClient | No | Custom WebSocket client (for testing). |

### Return Value

An object with two methods:

- `channel(name)` — create or retrieve a `RealtimeChannel`
- `removeChannel(channel)` — unsubscribe and remove a channel

### adapter.channel(name)

Creates a new `RealtimeChannel` or returns the existing one with that name. Channels are cached by name.

```javascript
const channel = adapter.channel('my-channel');
```

### adapter.removeChannel(channel)

Unsubscribes the channel (sends unsubscribe messages to AppSync for all subscriptions) and removes it from the cache.

```javascript
await adapter.removeChannel(channel);
```

## RealtimeChannel

Implements the Supabase channel interface. Created via `adapter.channel(name)`.

```javascript
import { RealtimeChannel } from 'events-lambda/adapter';
```

### Constructor

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Channel name (e.g., `'room1'`, `'my-channel'`). |
| `wsClient` | AppSyncWebSocketClient | WebSocket client instance. |
| `token` | string | Auth token for subscribe/publish operations. |

### channel.on(type, filter, callback)

Registers a listener for a specific event type. Returns `this` for chaining.

```javascript
channel
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, cb)
  .on('broadcast', { event: 'typing' }, cb)
```

#### Postgres Changes

| Filter Field | Type | Required | Default | Description |
|-------------|------|----------|---------|-------------|
| `event` | string | Yes | — | `'INSERT'`, `'UPDATE'`, `'DELETE'`, or `'*'`. |
| `schema` | string | No | `'public'` | Database schema. |
| `table` | string | Yes | — | Table name. |

Subscribes to AppSync channel `/db/{schema}/{table}/{event}`.

When `event` is `'*'`, subscribes to `/db/{schema}/{table}/*` (AppSync wildcard), which matches all event types.

#### Broadcast

| Filter Field | Type | Required | Description |
|-------------|------|----------|-------------|
| `event` | string | Yes | Broadcast event name (e.g., `'cursor-move'`, `'typing'`). |

Subscribes to AppSync channel `/broadcast/{channelName}/{event}`.

#### Callback Signature

**Postgres changes callback:**
```javascript
(payload) => {
  payload.schema           // 'public'
  payload.table            // 'messages'
  payload.commit_timestamp // '2026-04-12T18:00:00.000Z'
  payload.eventType        // 'INSERT' | 'UPDATE' | 'DELETE'
  payload.new              // new row data (or {} for DELETE)
  payload.old              // old row data (or {} for INSERT)
  payload.errors           // null
}
```

**Broadcast callback:**
```javascript
(payload) => {
  payload.event   // 'cursor-move'
  payload.payload // { x: 100, y: 200 }
  payload.type    // 'broadcast'
}
```

#### Validation

Channel names, table names, schema names, and broadcast event names are validated when `on()` is called. Invalid names are stored as errors and thrown when `subscribe()` is called.

Valid characters (after underscore-to-dash mapping): `[A-Za-z0-9-]`, max 50 characters per segment.

### channel.subscribe(statusCallback?)

Opens the WebSocket connection (if not already open), sends subscribe messages for all registered listeners, and reports status.

```javascript
await channel.subscribe((status, error) => {
  // status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'
});
```

**Behavior:**

- Idempotent. Calling `subscribe()` on an already-subscribed channel returns immediately.
- Throws if any `on()` call registered a validation error (invalid channel name, etc.).
- Calls `wsClient.connect()` to establish the WebSocket connection.
- Sends a `subscribe` message for each listener.
- Calls `statusCallback('SUBSCRIBED')` when all subscriptions succeed.
- Calls `statusCallback('CHANNEL_ERROR', error)` if any subscription fails.

### channel.send(message)

Sends a broadcast message. Only works for broadcast type.

```javascript
await channel.send({
  type: 'broadcast',
  event: 'cursor-move',
  payload: { x: 100, y: 200 },
});
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `'broadcast'`. |
| `event` | string | Yes | Broadcast event name. |
| `payload` | any | Yes | JSON-serializable payload. |

The message is wrapped in the broadcast format (`{event, payload, type: 'broadcast'}`) and published to `/broadcast/{channelName}/{event}` over the WebSocket.

**Payload size:** The entire serialized event (including wrapper) must not exceed 240 KB. Oversized payloads are silently dropped.

### channel.unsubscribe()

Sends unsubscribe messages for all active subscriptions and resets state.

```javascript
await channel.unsubscribe();
```

After unsubscribing, the channel can be re-subscribed by calling `subscribe()` again.

## AppSyncWebSocketClient

Manages the WebSocket connection to AppSync Events. A single instance is shared across all channels.

```javascript
import { AppSyncWebSocketClient } from 'events-lambda/adapter';
```

### Constructor

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `wsUrl` | string | Yes | — | WebSocket domain. |
| `httpUrl` | string | Yes | — | HTTP domain (for auth headers). |
| `token` | string | Yes | — | Cognito JWT. |
| `WebSocket` | class | No | `globalThis.WebSocket` | WebSocket constructor. |

### connect()

Establishes the WebSocket connection. Idempotent — returns the same promise if already connecting or connected.

```javascript
await client.connect();
```

**Connection handshake:**

1. Opens WebSocket to `{wsUrl}/event/realtime` with subprotocols:
   - `aws-appsync-event-ws`
   - `header-{base64url-encoded-auth}` (contains `{host, Authorization}`)
2. Sends `{type: 'connection_init'}` on open.
3. Resolves when server sends `{type: 'connection_ack', connectionTimeoutMs}`.
4. Rejects if WebSocket emits an error before `connection_ack`.

### subscribe(channel, token, callback)

Sends a subscribe message and registers the callback for incoming events.

```javascript
const subId = await client.subscribe('/db/public/messages/INSERT', token, (event) => {
  console.log(event);
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Full AppSync channel path. |
| `token` | string | Cognito JWT (sent in the per-subscription `authorization` field). |
| `callback` | function | Called for each incoming event on this subscription. |

Returns: `Promise<string>` — the subscription ID (UUID).

### publish(channel, events, token)

Publishes events over the WebSocket (for broadcast).

```javascript
await client.publish('/broadcast/room1/typing', [formattedEvent], token);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Full AppSync channel path. |
| `events` | Array&lt;object&gt; | Events to publish (stringified by the client). |
| `token` | string | Cognito JWT. |

Returns: `Promise<void>` — resolves on `publish_success`.

### unsubscribe(subscriptionId)

Unsubscribes from a specific subscription.

```javascript
await client.unsubscribe(subId);
```

Returns: `Promise<void>` — resolves on `unsubscribe_success`.

### onError(handler)

Registers a handler for connection-level errors.

```javascript
client.onError((event) => {
  console.error('WebSocket error:', event);
});
```

## WebSocket Protocol

The adapter communicates with AppSync Events using the following message types:

### Client to Server

| Type | When | Key Fields |
|------|------|------------|
| `connection_init` | After WebSocket opens | — |
| `subscribe` | Registering a subscription | `id`, `channel`, `authorization` |
| `unsubscribe` | Removing a subscription | `id` |
| `publish` | Sending broadcast | `id`, `channel`, `events`, `authorization` |

### Server to Client

| Type | When | Key Fields |
|------|------|------------|
| `connection_ack` | After `connection_init` | `connectionTimeoutMs` |
| `ka` | Keepalive (every 60s) | — |
| `data` | Event delivery | `id` (subscription), `event` (array of JSON strings) |
| `subscribe_success` | Subscription confirmed | `id` |
| `subscribe_error` | Subscription denied | `id`, `errors` |
| `publish_success` | Publish confirmed | `id` |
| `publish_error` | Publish denied | `id`, `errors` |
| `unsubscribe_success` | Unsubscription confirmed | `id` |
| `error` | Connection-level error | — |

### Event Delivery Format

Events arrive as an array of JSON strings in the `data` message:

```json
{
  "type": "data",
  "id": "subscription-uuid",
  "event": [
    "{\"schema\":\"public\",\"table\":\"messages\",\"eventType\":\"INSERT\",\"new\":{\"id\":\"abc\"},\"old\":{},\"errors\":null}"
  ]
}
```

The adapter parses each string and delivers the resulting object to the subscription callback. The array typically contains one element, but AppSync may batch events that arrive close together.

## Dependencies

The adapter has zero runtime dependencies. It uses the browser's native `WebSocket` API. For Node.js environments, the `ws` package is an optional peer dependency.

## Browser Compatibility

The adapter uses only cross-environment APIs:
- `WebSocket` (native in browsers, polyfilled by `ws` in Node.js)
- `btoa()` for base64url encoding (with `Buffer` fallback in Node.js)
- `TextEncoder` for payload size checking
- `crypto.randomUUID()` for subscription IDs
