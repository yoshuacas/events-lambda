# Task 05: WebSocket Client

Agent: implementer
Design: docs/design/realtime-api.md

## Objective

Implement the AppSync Events WebSocket client that manages
the connection lifecycle, subscribe/unsubscribe protocol,
and event routing to callbacks.

## Target Tests

From `src/adapter/websocket.test.mjs`:
- connect uses correct URL format
- connect includes aws-appsync-event-ws subprotocol
- connect includes base64url-encoded auth subprotocol
- connection_init is sent after WebSocket opens
- connection_ack is handled and timeout stored
- ka messages reset keepalive timer
- subscribe sends correct message format
- subscribe_success resolves the subscribe promise
- subscribe_error rejects the subscribe promise
- data messages are routed to subscription callbacks
- data messages with multiple events invoke callback
  per event
- wildcard subscription extracts eventType from payload
- publish sends correct message format (broadcast)
- publish_success resolves the publish promise
- unsubscribe sends correct message
- unsubscribe_success cleans up subscription state
- multiple subscriptions share single WebSocket
- connection-level error triggers error handler

## Implementation

### src/adapter/websocket.mjs

Create the `AppSyncWebSocketClient` class:

**Constructor:**
```javascript
constructor({ wsUrl, httpUrl }) {
  this.wsUrl = wsUrl;
  this.httpUrl = httpUrl;
  this.ws = null;
  this.subscriptions = new Map();  // id -> callback
  this.pendingOps = new Map();     // id -> {resolve, reject}
  this.connectionTimeoutMs = null;
  this.keepaliveTimer = null;
}
```

Accept an optional `WebSocketImpl` parameter for testing
(defaults to global `WebSocket` or `ws` in Node).

**`connect(token)`:**
1. Build the auth header JSON: `{host: httpUrl, Authorization: 'Bearer ' + token}`.
2. Base64url-encode it (no padding).
3. Create WebSocket with URL `{wsUrl}/event/realtime`
   and subprotocols `['aws-appsync-event-ws', 'header-' + encoded]`.
4. On `open`: send `{"type":"connection_init"}`.
5. On `message`: dispatch to handler by message `type`.

**Message handlers:**
- `connection_ack`: store `connectionTimeoutMs`, start
  keepalive timer.
- `ka`: reset keepalive timer.
- `data`: look up subscription by `id`, iterate `event`
  array, `JSON.parse()` each string, invoke callback
  with parsed object.
- `subscribe_success`: resolve pending operation.
- `subscribe_error`: reject pending operation.
- `publish_success`: resolve pending operation.
- `publish_error`: reject pending operation.
- `unsubscribe_success`: resolve pending operation,
  delete subscription from map.
- `error`: invoke error handler / trigger reconnect
  (queue for Phase 5; for now, just invoke a callback).

**`subscribe(channel, token, callback)`:**
1. Generate UUID for subscription ID.
2. Store callback in `subscriptions` map.
3. Create promise, store resolve/reject in `pendingOps`.
4. Send subscribe message with `id`, `channel`, and
   `authorization`.
5. Return the promise.

**`publish(channel, events, token)`:**
1. Generate UUID for operation ID.
2. Stringify each event in the array.
3. Create promise, store resolve/reject in `pendingOps`.
4. Send publish message with `id`, `channel`, `events`,
   and `authorization`.
5. Return the promise.

**`unsubscribe(subscriptionId)`:**
1. Create promise, store resolve/reject in `pendingOps`.
2. Send unsubscribe message with `id`.
3. Return the promise.

**Connection sharing:** The class maintains a single `ws`
instance. `connect()` is called once; subsequent
`subscribe()` calls reuse the same connection.

**Base64url encoding:** Use `btoa()` (browser) or
`Buffer.from().toString('base64')` (Node), then replace
`+` with `-`, `/` with `_`, remove trailing `=`.

## Test Requirements

No additional unit tests beyond those in Task 01.

## Acceptance Criteria

- All `src/adapter/websocket.test.mjs` tests pass.
- All previously passing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
- The adapter must extract `eventType` from the payload
  for wildcard subscriptions, not from the channel name.
  If the wildcard test passes without this extraction
  logic, the test may not be targeting the right behavior.
