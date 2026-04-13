# Realtime API

## Overview

Implement the events-lambda library: a server-side event
publisher and a client-side adapter that together provide
Supabase Realtime-compatible push notifications backed by
AWS AppSync Events.

The server-side publisher is an npm package that
pgrest-lambda (or any backend) calls after a successful
write. It signs an HTTP POST with IAM SigV4 and sends the
event to AppSync Events. The client-side adapter translates
`@supabase/supabase-js` realtime API calls (`channel()`,
`on('postgres_changes', ...)`, broadcast, presence) into
AppSync Events WebSocket subscriptions. Developers write
standard Supabase client code; the adapter handles the
translation.

AppSync Events manages all WebSocket infrastructure:
connection lifecycle, channel subscriptions, fan-out to
subscribers. This library never manages connections,
connection tables, or fan-out.

## Current CX / Concepts

There is no existing realtime functionality. pgrest-lambda
handles REST operations (INSERT, UPDATE, DELETE) against
Aurora DSQL, but changes are not pushed to subscribers.
Clients must poll the REST API to detect changes.

Supabase provides a realtime server that parses the
PostgreSQL WAL and pushes changes over WebSocket. Aurora
DSQL has no triggers, no LISTEN/NOTIFY, and no logical
replication, so WAL-based realtime is not possible. This
library uses application-layer event publishing instead:
the backend publishes an event after each successful write,
and AppSync Events delivers it to subscribers.

## Proposed CX / CX Specification

### Postgres Changes

Subscribe to INSERT, UPDATE, DELETE events on specific
tables. The client API is standard `@supabase/supabase-js`:

```javascript
import { createClient } from '@supabase/supabase-js';
import { createRealtimeAdapter } from 'events-lambda/adapter';

const supabase = createClient(apiUrl, anonKey, {
  realtime: createRealtimeAdapter({
    httpUrl: realtimeHttpUrl,
    wsUrl: realtimeWsUrl,
  })
});

supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New message:', payload.new)
  )
  .subscribe()
```

#### Payload format (must match Supabase)

INSERT:
```json
{
  "schema": "public",
  "table": "messages",
  "commit_timestamp": "2026-04-12T18:00:00Z",
  "eventType": "INSERT",
  "new": { "id": "abc", "text": "hello", "user_id": "u-1" },
  "old": {},
  "errors": null
}
```

UPDATE:
```json
{
  "schema": "public",
  "table": "messages",
  "commit_timestamp": "2026-04-12T18:00:01Z",
  "eventType": "UPDATE",
  "new": { "id": "abc", "text": "updated", "user_id": "u-1" },
  "old": { "id": "abc", "text": "hello", "user_id": "u-1" },
  "errors": null
}
```

DELETE:
```json
{
  "schema": "public",
  "table": "messages",
  "commit_timestamp": "2026-04-12T18:00:02Z",
  "eventType": "DELETE",
  "new": {},
  "old": { "id": "abc", "text": "updated", "user_id": "u-1" },
  "errors": null
}
```

#### Subscription event types

- `event: 'INSERT'` — receive only INSERT events
- `event: 'UPDATE'` — receive only UPDATE events
- `event: 'DELETE'` — receive only DELETE events
- `event: '*'` — receive all event types for the table

#### Server-side publisher API

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After INSERT:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: result.rows[0],
  oldRow: null,
});

// After UPDATE:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'UPDATE',
  newRow: result.rows[0],
  oldRow: previousRow,
});

// After DELETE:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'DELETE',
  newRow: null,
  oldRow: deletedRow,
});
```

`publishChange` is fire-and-forget. It must not throw or
block the caller. If the HTTP POST to AppSync fails, the
error is logged and the write response proceeds normally.

#### Validation rules

- `schema` must be a non-empty string. After sanitization
  (underscore-to-dash mapping via `sanitizeSegment`), the
  result must match `[A-Za-z0-9-]+` and be at most 50
  characters. Default: `'public'`.
- `table` must be a non-empty string. After sanitization,
  the result must match `[A-Za-z0-9-]+` and be at most 50
  characters. Underscores are allowed in the input and are
  mapped to dashes by `sanitizeSegment` (e.g.,
  `user_profiles` becomes `user-profiles`). Characters
  other than `[A-Za-z0-9_-]` in the input are rejected.
  This mapping is defined in `shared/protocol.mjs` and is
  consistent between publisher and adapter.
- `event` must be one of `'INSERT'`, `'UPDATE'`, `'DELETE'`.
  The publisher does not accept `'*'` — that is a
  subscription-side concept only.
- `newRow` must be a non-null object for INSERT and UPDATE.
  Must be null or omitted for DELETE.
- `oldRow` must be a non-null object for UPDATE and DELETE.
  Must be null or omitted for INSERT.
- Serialized event payload must not exceed 240 KB (AppSync
  Events per-event size limit).

Error messages:
- `"event must be INSERT, UPDATE, or DELETE"` — when event
  is not one of the three valid types.
- `"table is required"` — when table is empty or missing.
- `"schema contains characters not allowed in AppSync channel segments"` — when schema (after underscore-to-dash
  mapping) contains characters outside `[A-Za-z0-9-]`.
- `"schema exceeds 50-character AppSync segment limit"` —
  when sanitized schema exceeds length limit.
- `"table contains characters not allowed in AppSync channel segments"` — when table (after underscore-to-dash
  mapping) contains characters outside `[A-Za-z0-9-]`.
- `"table exceeds 50-character AppSync segment limit"` —
  when sanitized table exceeds length limit.
- `"newRow is required for INSERT and UPDATE events"` —
  when newRow is null for INSERT or UPDATE.
- `"oldRow is required for UPDATE and DELETE events"` —
  when oldRow is null for UPDATE or DELETE.
- `"event payload exceeds 240 KB limit"` — when the
  serialized payload exceeds AppSync's per-event maximum.

### Broadcast

Client-to-client pub/sub relayed through AppSync Events.
Messages do not go through the database or Lambda.

```javascript
const channel = supabase.channel('room1')

channel.on('broadcast', { event: 'cursor-move' }, (payload) => {
  console.log('Cursor:', payload.payload)
})

channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    channel.send({
      type: 'broadcast',
      event: 'cursor-move',
      payload: { x: 100, y: 200 }
    })
  }
})
```

#### Broadcast payload format

The callback receives:
```json
{
  "event": "cursor-move",
  "payload": { "x": 100, "y": 200 },
  "type": "broadcast"
}
```

Both publish and subscribe use Cognito auth. The client
publishes directly to AppSync Events over the WebSocket
connection using the `publish` message type — no Lambda
intermediary.

#### Validation rules

- `event` (broadcast event name) must be a non-empty string
  containing only `[A-Za-z0-9-]` (alphanumeric and dash),
  maximum 50 characters. This constraint comes from AppSync
  channel segment naming rules.
- `payload` must be a JSON-serializable value. Maximum
  serialized size: 240 KB (AppSync Events limit). Note:
  this is the size of the entire stringified event
  (including the broadcast wrapper with `event`, `payload`,
  and `type` fields), not just the `payload` field alone.
- Channel name (the argument to `supabase.channel()`) must
  be a non-empty string. After sanitization (underscore-to-
  dash mapping), the result must match `[A-Za-z0-9-]+` and
  be at most 50 characters. Supabase channel names commonly
  use underscores (e.g., `my_channel`), which are mapped to
  dashes by `sanitizeSegment`.

Error messages:
- `"broadcast event name must match [A-Za-z0-9-]+ and be at most 50 characters"` — when event name contains
  invalid characters or exceeds length limit.
- `"channel name must match [A-Za-z0-9-]+ and be at most 50 characters"` — when channel name contains invalid
  characters or exceeds length limit.
- `"payload exceeds 240 KB limit"` — when serialized event
  (including broadcast wrapper) is too large.

### Presence (Phase 3 — deferred)

Track which users are online and share ephemeral state.
Uses a client-side CRDT approach (same as Supabase): each
client broadcasts its presence on join and on a heartbeat
interval, maintains a local map of all presences, and
removes entries after a timeout.

```javascript
channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState()
})

channel.on('presence', { event: 'join' },
  ({ key, newPresences }) => {}
)

channel.on('presence', { event: 'leave' },
  ({ key, leftPresences }) => {}
)

channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.track({
      user: userId,
      online_at: new Date().toISOString()
    })
  }
})
```

Presence is P2 priority. The design is included here for
completeness but implementation is deferred to Phase 3.

### Row-Level Filtering (Phase 4)

Client-side filter evaluation against incoming events.
The publisher sends all events for the table; the adapter
evaluates filters locally before invoking the callback.

```javascript
supabase.channel('filtered')
  .on('postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'messages',
      filter: 'room_id=eq.123'
    },
    (payload) => console.log('Room 123 update:', payload)
  )
  .subscribe()
```

#### Supported filter operators

| Operator | Syntax               | Example              |
|----------|----------------------|----------------------|
| eq       | `column=eq.value`    | `room_id=eq.123`     |
| neq      | `column=neq.value`   | `status=neq.draft`   |
| lt       | `column=lt.value`    | `age=lt.18`          |
| lte      | `column=lte.value`   | `age=lte.65`         |
| gt       | `column=gt.value`    | `score=gt.100`       |
| gte      | `column=gte.value`   | `score=gte.50`       |
| in       | `column=in.(a,b,c)`  | `status=in.(a,b,c)`  |

Filters are evaluated against the `new` record for INSERT
and UPDATE events. DELETE events cannot be filtered (same
as Supabase) — all DELETE callbacks fire regardless of
filter.

Row-level filtering is P1 priority, implemented in Phase 4.

### Channel Status Callbacks

The `subscribe()` method accepts a callback that receives
channel status updates:

```javascript
channel.subscribe((status) => {
  // status is one of:
  // 'SUBSCRIBED' — WebSocket connected, subscription active
  // 'CHANNEL_ERROR' — subscription failed
  // 'CLOSED' — channel unsubscribed
  // 'TIMED_OUT' — connection timed out
})
```

### Unsubscribe

```javascript
supabase.removeChannel(channel)
// or
channel.unsubscribe()
```

Sends an `unsubscribe` message to AppSync Events and
closes the WebSocket if no other subscriptions remain.

## Technical Design

### Channel Naming Convention

AppSync Events channel names consist of 1-5 segments
separated by `/`. Each segment allows up to 50 characters
matching `[A-Za-z0-9-]` (alphanumeric and dash only — no
dots, underscores, or other special characters). Channel
names are case-sensitive.

The original requirements used dots in channel names
(e.g., `/db/public.messages.INSERT`). This violates
AppSync's naming rules. The design uses path segments
instead:

| Supabase Concept | AppSync Channel |
|------------------|-------------------------------|
| postgres_changes INSERT on public.messages | `/db/public/messages/INSERT` |
| postgres_changes * on public.messages | `/db/public/messages/*` |
| broadcast event cursor-move on channel room1 | `/broadcast/room1/cursor-move` |
| presence on channel room1 | `/presence/room1` |

Segment count by feature:
- postgres_changes: 4 segments (`db`, schema, table, event)
- broadcast: 3 segments (`broadcast`, channel, event)
- presence: 2 segments (`presence`, channel)

All are within the 5-segment limit.

Wildcard subscriptions (`*` as the last segment) are a
special AppSync Events subscription feature — `*` is not a
literal channel segment and does not appear in published
channel names. It is valid only in subscribe messages. When
a Supabase client subscribes with `event: '*'`, the adapter
subscribes to `/db/{schema}/{table}/*`, which matches all
events published to `/db/{schema}/{table}/INSERT`,
`/db/{schema}/{table}/UPDATE`, and
`/db/{schema}/{table}/DELETE`.

When a wildcard subscription receives a `data` message, the
adapter must determine the actual event type (INSERT,
UPDATE, DELETE) from the event payload's `eventType` field,
not from the subscription channel name (which is the
wildcard pattern). The subscription `id` in the `data`
message corresponds to the wildcard subscription, so the
adapter cannot derive the event type from subscription
routing alone.

### AppSync Events HTTP Publish

The publisher sends events via HTTP POST:

```
POST https://{HTTP_DOMAIN}/event
Content-Type: application/json
Authorization: <IAM SigV4 signature>

{
  "channel": "/db/public/messages/INSERT",
  "events": [
    "{\"schema\":\"public\",\"table\":\"messages\",\"commit_timestamp\":\"2026-04-12T18:00:00Z\",\"eventType\":\"INSERT\",\"new\":{\"id\":\"abc\"},\"old\":{},\"errors\":null}"
  ]
}
```

Key details:
- Events in the `events` array are **stringified JSON**,
  not objects. Each event is a JSON string.
- Maximum 5 events per request.
- Maximum event size: 240 KB.
- Auth: IAM SigV4 signing using the Lambda execution role.
  Only the Lambda can publish to `/db/*` channels.

The publisher sends one event per `publishChange` call.
Batching multiple events into a single HTTP request is a
future optimization.

### AppSync Events WebSocket Protocol

The adapter connects to AppSync Events over WebSocket:

```
wss://{REALTIME_DOMAIN}/event/realtime
```

#### Connection handshake

The WebSocket connection requires two subprotocols:
1. `aws-appsync-event-ws`
2. `header-<base64url-encoded-auth>`

The auth header for Cognito is:
```json
{
  "host": "{HTTP_DOMAIN}",
  "Authorization": "Bearer <JWT_ID_TOKEN>"
}
```

This is base64url-encoded (no padding) and passed as the
`header-...` subprotocol.

#### Connection lifecycle

1. Client opens WebSocket with subprotocols.
2. Client sends `{"type": "connection_init"}`.
3. Server responds with
   `{"type": "connection_ack", "connectionTimeoutMs": 300000}`.
4. Server sends keepalive `{"type": "ka"}` every 60 seconds.
5. If no keepalive within `connectionTimeoutMs` (5 minutes),
   client closes and reconnects.
6. Maximum connection duration: 24 hours.

#### Subscribe

Client sends:
```json
{
  "type": "subscribe",
  "id": "<unique-subscription-id>",
  "channel": "/db/public/messages/INSERT",
  "authorization": {
    "host": "<HTTP_DOMAIN>",
    "Authorization": "Bearer <JWT>"
  }
}
```

Server responds:
```json
{
  "type": "subscribe_success",
  "id": "<subscription-id>"
}
```

The `id` field is a unique string per subscription (1-128
characters, `[a-zA-Z0-9-_+]`). The adapter generates a
UUID for each subscription.

#### Event delivery

When an event is published to a subscribed channel, the
server sends:
```json
{
  "type": "data",
  "id": "<subscription-id>",
  "event": ["{\"schema\":\"public\",...}"]
}
```

The `event` field is an array of stringified JSON strings.
Each element is a JSON string that must be parsed
individually. The adapter iterates the array, parses each
string with `JSON.parse()`, and delivers the resulting
object to the matching callback. In practice, the publisher
sends one event per publish call, so the array typically
contains one element — but the adapter must handle multiple
elements because AppSync batches events within a single
delivery when they arrive close together.

#### Publish (broadcast only)

For broadcast, the client publishes directly over WebSocket:
```json
{
  "type": "publish",
  "id": "<operation-id>",
  "channel": "/broadcast/room1/cursor-move",
  "events": [
    "{\"event\":\"cursor-move\",\"payload\":{\"x\":100,\"y\":200},\"type\":\"broadcast\"}"
  ],
  "authorization": {
    "host": "<HTTP_DOMAIN>",
    "Authorization": "Bearer <JWT>"
  }
}
```

Server responds:
```json
{
  "type": "publish_success",
  "id": "<operation-id>",
  "successful": [{"identifier": "<uuid>", "index": 0}],
  "failed": []
}
```

#### Unsubscribe

Client sends:
```json
{
  "type": "unsubscribe",
  "id": "<subscription-id>"
}
```

Server responds:
```json
{
  "type": "unsubscribe_success",
  "id": "<subscription-id>"
}
```

### Server-Side Publisher

#### createEventPublisher(config)

Factory function that returns a publisher instance.

```javascript
const publisher = createEventPublisher({
  apiEndpoint,  // Required. AppSync Events HTTP endpoint.
  region,       // Required. AWS region for SigV4 signing.
});
```

The publisher creates a `SignatureV4` signer from
`@smithy/signature-v4` using `@aws-sdk/credential-provider-node`
for credentials and `@aws-crypto/sha256-js` for hashing.

#### publisher.publishChange(params)

Builds the Supabase-compatible payload, maps it to the
correct AppSync channel, signs the request, and sends it.

```javascript
async publishChange({ schema = 'public', table, event, newRow, oldRow }) {
  // validate params (see validation rules above)
  const channel = pgChangesChannel(schema, table, event);
  const payload = {
    schema,
    table,
    commit_timestamp: new Date().toISOString(),
    eventType: event,
    new: newRow || {},
    old: oldRow || {},
    errors: null,
  };
  // Note: publish() stringifies the payload before sending
  // (AppSync Events requires events as JSON strings)
  await this.client.publish(channel, [payload]);
}
```

Note: the `payload.schema` and `payload.table` retain the
original values (e.g., `user_profiles` with underscores),
preserving Supabase payload compatibility. Only the channel
path uses the sanitized form.

Fire-and-forget behavior: `publishChange` catches all
errors internally and logs them. It never throws.

```javascript
async publishChange(params) {
  try {
    // validate, build payload, sign, send
  } catch (err) {
    console.error('events-lambda: publish failed', err);
  }
}
```

#### AppSyncEventsClient

Low-level HTTP client that signs and sends requests.

```javascript
class AppSyncEventsClient {
  constructor({ apiEndpoint, region })
  async publish(channel, events)
}
```

`publish` performs:
1. Serialize each event to a JSON string (the events array
   contains stringified JSON per AppSync protocol).
2. Build the request body: `{channel, events}`.
3. Sign the request with SigV4 (service: `appsync`).
4. Send via `fetch()`.
5. Check response status. Log errors but do not throw.

### Client-Side Adapter

#### createRealtimeAdapter(config)

Returns an object that `@supabase/supabase-js` accepts as
the `realtime` option. The adapter intercepts the channel
creation and subscription methods.

```javascript
const adapter = createRealtimeAdapter({
  httpUrl,  // AppSync Events HTTP domain (for auth header)
  wsUrl,    // AppSync Events WebSocket domain
});
```

#### RealtimeChannel

Implements the Supabase channel interface:

- `on(type, filter, callback)` — registers a listener.
  - `type: 'postgres_changes'` — subscribes to
    `/db/{schema}/{table}/{event}` or
    `/db/{schema}/{table}/*`.
  - `type: 'broadcast'` — subscribes to
    `/broadcast/{channel}/{event}`.
  - `type: 'presence'` — subscribes to
    `/presence/{channel}`.
- `subscribe(callback)` — opens the WebSocket (if not
  already open), sends subscribe messages for all
  registered listeners, and calls the status callback.
- `send(message)` — for broadcast, publishes via WebSocket.
- `unsubscribe()` — sends unsubscribe messages and
  cleans up.
- `track(state)` — presence tracking (Phase 3).
- `untrack()` — stop tracking (Phase 3).
- `presenceState()` — get current presence (Phase 3).

#### AppSyncWebSocketClient

Manages the WebSocket connection to AppSync Events.

- Connects on first subscription.
- Shares a single WebSocket across all channels and
  subscriptions.
- Handles `connection_ack`, `ka` (keepalive), `data`,
  `subscribe_success`, `subscribe_error`, `publish_success`,
  `publish_error`, `unsubscribe_success`, and `error`
  message types.
- On `subscribe_error`: invokes the channel status callback
  with `'CHANNEL_ERROR'`. Common cause: Cognito token
  lacks authorization for the requested channel (Cedar
  policy denial).
- On `error` (connection-level): logs the error and
  triggers reconnection.
- Reconnects with exponential backoff on disconnect
  (Phase 5).
- Tracks subscription IDs to route incoming `data` messages
  to the correct callback.

#### Channel Name Mapping (shared/protocol.mjs)

Functions used by both publisher and adapter:

```javascript
// Sanitize a name for use as an AppSync channel segment.
// Replaces underscores with dashes. Throws if the result
// contains characters outside [A-Za-z0-9-] or exceeds
// 50 characters.
function sanitizeSegment(name) {
  const sanitized = name.replace(/_/g, '-');
  if (!/^[A-Za-z0-9-]+$/.test(sanitized)) {
    throw new Error(
      `"${name}" contains characters not allowed in AppSync channel segments`
    );
  }
  if (sanitized.length > 50) {
    throw new Error(
      `"${name}" exceeds 50-character AppSync segment limit`
    );
  }
  return sanitized;
}

// Postgres changes channel
function pgChangesChannel(schema, table, event) {
  return `/db/${sanitizeSegment(schema)}/${sanitizeSegment(table)}/${event}`;
}

// Broadcast channel
function broadcastChannel(channelName, eventName) {
  return `/broadcast/${sanitizeSegment(channelName)}/${sanitizeSegment(eventName)}`;
}

// Presence channel
function presenceChannel(channelName) {
  return `/presence/${sanitizeSegment(channelName)}`;
}
```

The `sanitizeSegment` function is the single point of
enforcement for AppSync's channel segment naming rules.
Both publisher and adapter call these functions, so the
underscore-to-dash mapping is consistent on both sides.
This means a Supabase client subscribing to table
`user_profiles` and a publisher emitting events for table
`user_profiles` both resolve to the same channel:
`/db/public/user-profiles/INSERT`.

These functions enforce the naming convention contract
between publisher and adapter.

### Edge Cases and Adapter Behavior

#### Token refresh and reconnection

Cognito JWTs expire (typically after 1 hour). The adapter
must handle token refresh:
- The `authorization` field is sent per-subscribe and
  per-publish message, not just at connection time. The
  connection auth is established via the subprotocol header.
- When a subscribe or publish fails with an auth error, the
  adapter should request a fresh token from the Supabase
  client's auth session before retrying.
- On WebSocket disconnect (e.g., after the 24-hour maximum
  connection duration), the adapter reconnects with a fresh
  token and re-subscribes to all active subscriptions.

#### Multiple `on()` calls on the same channel

A single Supabase channel can have multiple `on()` listeners
for different tables or event types:

```javascript
supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    handleNewMessage)
  .on('postgres_changes',
    { event: 'DELETE', schema: 'public', table: 'messages' },
    handleDeletedMessage)
  .on('broadcast', { event: 'typing' }, handleTyping)
  .subscribe()
```

Each `on()` call results in a separate AppSync subscription
(separate `subscribe` message with a unique `id`). The
adapter maintains a map from subscription ID to callback.

#### Duplicate subscription prevention

If a client calls `subscribe()` on a channel that is already
subscribed, the adapter should be idempotent — do not send
duplicate subscribe messages to AppSync.

#### Ordering guarantees

AppSync Events does not guarantee event ordering across
different publish calls. Events published in separate HTTP
requests may arrive at subscribers in any order. The adapter
does not attempt to reorder events. The `commit_timestamp`
field is available for clients that need ordering.

### Infrastructure (SAM Template)

```yaml
RealtimeApi:
  Type: AWS::AppSync::Api
  Properties:
    Name: !Sub "${ProjectName}-realtime"
    EventConfig:
      AuthProviders:
        - AuthType: AMAZON_COGNITO_USER_POOLS
          CognitoConfig:
            UserPoolId: !Ref UserPool
            AwsRegion: !Ref AWS::Region
        - AuthType: AWS_IAM
      ConnectionAuthModes:
        - AuthType: AMAZON_COGNITO_USER_POOLS
      DefaultPublishAuthModes:
        - AuthType: AWS_IAM
      DefaultSubscribeAuthModes:
        - AuthType: AMAZON_COGNITO_USER_POOLS
```

Channel namespace configuration with per-namespace auth
overrides:

```yaml
      ChannelNamespaces:
        - Name: db
          # Default: IAM publish, Cognito subscribe
        - Name: broadcast
          PublishAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
          SubscribeAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
        - Name: presence
          PublishAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
          SubscribeAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
```

Auth model:
- `/db/*`: IAM publish (Lambda only), Cognito subscribe.
  Clients cannot publish postgres_changes events directly.
- `/broadcast/*`: Cognito publish and subscribe.
  Client-to-client, no Lambda involved.
- `/presence/*`: Cognito publish and subscribe.
  Client-to-client presence tracking.

IAM policy for the Lambda execution role:
```yaml
- Statement:
    - Effect: Allow
      Action:
        - appsync:EventPublish
      Resource:
        - !Sub "arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${RealtimeApi.ApiId}/*"
```

Environment variables:
```yaml
Environment:
  Variables:
    APPSYNC_EVENTS_ENDPOINT: !GetAtt RealtimeApi.Dns.Http
    APPSYNC_EVENTS_REALTIME: !GetAtt RealtimeApi.Dns.Realtime
```

### Dependencies

Server-side (Lambda):
```json
{
  "@aws-sdk/credential-provider-node": "^3.0.0",
  "@aws-crypto/sha256-js": "^5.0.0",
  "@smithy/signature-v4": "^3.0.0"
}
```

Client-side (browser): zero runtime dependencies. Uses
the native `WebSocket` API. `ws` is an optional peer
dependency for Node.js environments.

## Code Architecture / File Changes

### New files

```
src/
├── publisher/
│   ├── index.mjs            # createEventPublisher() factory
│   ├── appsync-client.mjs   # AppSyncEventsClient class
│   └── channel-map.mjs      # pgChangesChannel() — publisher side
├── adapter/
│   ├── index.mjs            # createRealtimeAdapter() entry point
│   ├── channel.mjs          # RealtimeChannel class
│   ├── websocket.mjs        # AppSyncWebSocketClient class
│   ├── broadcast.mjs        # Broadcast send/receive logic
│   └── presence.mjs         # Presence CRDT logic (Phase 3)
└── shared/
    ├── protocol.mjs         # Channel naming functions, payload format
    └── errors.mjs           # Error codes and messages

infrastructure/
└── realtime.yaml            # SAM template snippet
```

### Modified files

- `package.json` — already configured with correct exports
  and dependencies. No changes needed.

### File responsibilities

**src/shared/protocol.mjs** — The single source of truth
for channel naming. Both publisher and adapter import from
here. Contains `pgChangesChannel()`,
`broadcastChannel()`, `presenceChannel()`, and payload
validation/construction helpers.

**src/shared/errors.mjs** — Error code constants and
message templates. Used by both publisher and adapter for
consistent error reporting.

**src/publisher/index.mjs** — Exports `createEventPublisher`.
Validates config, creates the `AppSyncEventsClient`,
returns the publisher object with `publishChange` and
`publish` methods.

**src/publisher/appsync-client.mjs** — HTTP client for
AppSync Events. Handles SigV4 signing and HTTP POST.
Catches errors and logs them (fire-and-forget).

**src/publisher/channel-map.mjs** — Re-exports
`pgChangesChannel` from shared/protocol for convenience.

**src/adapter/index.mjs** — Exports `createRealtimeAdapter`.
Returns the object that replaces
`@supabase/realtime-js` in the supabase client config.

**src/adapter/channel.mjs** — `RealtimeChannel` class.
Implements `on()`, `subscribe()`, `send()`,
`unsubscribe()`, `track()`, `untrack()`,
`presenceState()`. Routes calls to the WebSocket client.

**src/adapter/websocket.mjs** — `AppSyncWebSocketClient`.
Manages the single WebSocket connection, handles protocol
messages, routes events to channel callbacks.

**src/adapter/broadcast.mjs** — Broadcast-specific logic:
payload formatting for send, payload parsing for receive.

**src/adapter/presence.mjs** — Presence CRDT state
management (Phase 3). Heartbeat scheduling, timeout
detection, join/leave event emission.

**infrastructure/realtime.yaml** — SAM template snippet
for the AppSync Events API, channel namespaces, and IAM
policy.

## Testing Strategy

### Unit tests

**src/shared/protocol.test.mjs**
- `pgChangesChannel('public', 'messages', 'INSERT')`
  returns `'/db/public/messages/INSERT'`
- `pgChangesChannel('public', 'messages', '*')` returns
  `'/db/public/messages/*'`
- `broadcastChannel('room1', 'cursor-move')` returns
  `'/broadcast/room1/cursor-move'`
- `presenceChannel('room1')` returns `'/presence/room1'`
- Channel names with invalid characters are rejected
- `sanitizeSegment('user_profiles')` returns
  `'user-profiles'` (underscore to dash mapping)
- `sanitizeSegment('a'.repeat(51))` throws (exceeds 50
  character segment limit)
- `sanitizeSegment('hello.world')` throws (dot is not
  allowed in segments)
- `pgChangesChannel('public', 'user_profiles', 'INSERT')`
  returns `'/db/public/user-profiles/INSERT'` (end-to-end
  underscore mapping)

**src/publisher/index.test.mjs**
- `publishChange` with valid INSERT params builds correct
  payload and calls `AppSyncEventsClient.publish` with
  channel `/db/public/messages/INSERT`
- `publishChange` with valid UPDATE params includes both
  `new` and `old` in payload
- `publishChange` with valid DELETE params has empty `new`
  and populated `old`
- `publishChange` with missing `table` does not call
  publish and logs an error
- `publishChange` with invalid `event` ('*') does not
  call publish and logs an error
- `publishChange` with missing `newRow` for INSERT does
  not call publish and logs an error
- `publishChange` with missing `oldRow` for DELETE does
  not call publish and logs an error
- `publishChange` with table name containing underscores
  publishes to the dash-mapped channel name
- `publishChange` with table name exceeding 50 characters
  (after sanitization) does not call publish and logs error
- `publishChange` catches HTTP errors and does not throw
- `commit_timestamp` is a valid ISO 8601 string
- `publishChange` with payload exceeding 240 KB does not
  call publish and logs an error

**src/publisher/appsync-client.test.mjs**
- `publish` sends POST to `{endpoint}/event` with correct
  Content-Type header
- Request body contains `channel` and `events` array
- Events in the array are stringified JSON strings (verify
  with `typeof events[0] === 'string'` and
  `JSON.parse(events[0])` succeeds)
- Maximum 5 events per request (AppSync limit). Verify
  batches over 5 are split into multiple requests.
- SigV4 signature is applied (mock the signer, verify
  `sign` is called with service name `appsync`)
- HTTP errors are caught and logged, not thrown

**src/adapter/channel.test.mjs**
- `on('postgres_changes', {event: 'INSERT', schema:
  'public', table: 'messages'}, cb)` registers a
  subscription to `/db/public/messages/INSERT`
- `on('postgres_changes', {event: '*', ...}, cb)`
  registers a subscription to `/db/public/messages/*`
- `on('broadcast', {event: 'cursor-move'}, cb)` registers
  a subscription to `/broadcast/{channel}/cursor-move`
- `subscribe()` opens WebSocket and sends subscribe
  messages
- `subscribe(cb)` calls callback with `'SUBSCRIBED'`
  after `subscribe_success`
- `subscribe(cb)` calls callback with `'CHANNEL_ERROR'`
  after `subscribe_error`
- `send({type: 'broadcast', event, payload})` sends a
  publish message over WebSocket to the correct channel
  (`/broadcast/{channel}/{event}`)
  [Risk: a test that only checks a publish message was sent
  without verifying the channel path could pass even if the
  channel mapping is wrong.]
- `unsubscribe()` sends unsubscribe messages for all
  subscriptions
- Calling `subscribe()` twice on the same channel does not
  send duplicate subscribe messages (idempotency)
- Incoming `data` messages are parsed and routed to the
  correct callback
  [Risk: a test with only one subscription cannot
  distinguish between "routed correctly" and "delivered to
  all callbacks". Test with multiple subscriptions where
  only one should fire.]
- Multiple `on()` listeners on a single channel produce
  separate AppSync subscriptions with distinct IDs

**src/adapter/websocket.test.mjs**
- Connection uses correct URL format
  (`wss://{domain}/event/realtime`)
- Connection includes `aws-appsync-event-ws` subprotocol
- Connection includes base64url-encoded auth subprotocol
- `connection_init` is sent after connection opens
- `connection_ack` is handled and timeout is stored
- `ka` messages reset the keepalive timer
- `data` messages are routed to subscription callbacks
- `subscribe_success` resolves the subscribe promise
- `subscribe_error` rejects the subscribe promise and
  invokes the channel status callback with
  `'CHANNEL_ERROR'`
- `publish_success` resolves the publish promise
- `unsubscribe_success` cleans up subscription state
- Multiple subscriptions share a single WebSocket
- Wildcard subscription (`/db/public/messages/*`) receives
  events published to `/db/public/messages/INSERT` — verify
  the adapter extracts `eventType` from the payload, not
  from the subscription channel name
  [Risk: a test that only checks the callback was invoked
  could pass even if the adapter routes by subscription ID
  alone and ignores eventType extraction. Verify the
  callback receives the correct eventType value.]
- `data` messages with multiple events in the array invoke
  the callback once per event, not once per message
- Connection-level `error` message triggers reconnection
  logic (or queues it for Phase 5)

### Integration tests

Integration tests require a deployed AppSync Events API
and are run separately from unit tests.

- Publish an INSERT event via the publisher, verify a
  subscribed WebSocket client receives it with correct
  Supabase payload format.
- Publish UPDATE and DELETE events, verify `new` and `old`
  fields match expectations.
- Subscribe with `event: '*'`, verify all event types
  (INSERT, UPDATE, DELETE) are received.
- Broadcast: client A sends, client B receives with
  correct payload format.
- Verify IAM-only publish on `/db/*` — client publish
  attempt is rejected.
- Verify Cognito publish on `/broadcast/*` — client
  publish succeeds.
- Subscribe with wildcard, publish INSERT then DELETE,
  verify both arrive and the adapter correctly identifies
  each event type from the payload.
- Table name with underscore (e.g., `user_profiles`):
  verify publisher and adapter agree on the channel name
  (both use `/db/public/user-profiles/INSERT`).
- Publish event near 240 KB limit: verify it succeeds.
  Publish event exceeding 240 KB: verify it is rejected
  (publisher-side validation) or returns an error from
  AppSync.
- WebSocket disconnect and reconnect: verify subscriptions
  are re-established after reconnect (Phase 5, but the
  test harness should be set up now).

## Implementation Order

### Phase 1: Postgres Changes (P0)

1. **Shared protocol** — `src/shared/protocol.mjs` and
   `src/shared/errors.mjs`. Channel naming functions and
   payload format helpers. Unit tests.
2. **Publisher** — `src/publisher/appsync-client.mjs` and
   `src/publisher/index.mjs`. SigV4 signing, HTTP POST,
   fire-and-forget semantics. Unit tests with mocked HTTP.
3. **WebSocket client** — `src/adapter/websocket.mjs`.
   Connection lifecycle, subscribe/unsubscribe, event
   routing. Unit tests with mocked WebSocket.
4. **Channel adapter** — `src/adapter/channel.mjs` and
   `src/adapter/index.mjs`. Supabase channel API
   implementation for postgres_changes. Unit tests.
5. **SAM template** — `infrastructure/realtime.yaml`.
   AppSync Events API with channel namespaces and IAM
   policy.

### Phase 2: Broadcast (P0)

6. **Broadcast** — `src/adapter/broadcast.mjs`. Client
   publish via WebSocket, receive via subscription. Unit
   tests.
7. **Broadcast namespace auth** — Update SAM template to
   allow Cognito publish on `/broadcast/*`.

### Phase 3: Presence (P2 — deferred)

8. **Presence CRDT** — `src/adapter/presence.mjs`.
   Client-side state tracking, heartbeat, timeout, join/
   leave events. Unit tests.

### Phase 4: Row-Level Filtering (P1)

9. **Client-side filters** — Filter evaluation in
   `src/adapter/channel.mjs`. Parse filter strings,
   evaluate against incoming event payloads. Unit tests.

### Phase 5: Hardening

10. **Reconnection** — Exponential backoff in
    `src/adapter/websocket.mjs`.
11. **Missed message detection** — Sequence numbers or
    timestamps.
12. **Cedar policies** — Channel-level subscribe
    authorization.
13. **Rate limiting** — Publish throttling.

## Open Questions

1. **Broadcast namespace auth syntax** — The SAM template
   uses `PublishAuthModes` and `SubscribeAuthModes` on
   channel namespaces. The exact CloudFormation property
   names need verification against the latest
   `AWS::AppSync::ChannelNamespace` resource spec.

2. **Wildcard subscription delivery** — When a client
   subscribes to `/db/public/messages/*` and an event is
   published to `/db/public/messages/INSERT`, AppSync
   delivers it with the subscription `id` for the wildcard
   subscription. The adapter extracts the event type from
   the payload's `eventType` field (see "Channel Naming
   Convention" section above). This behavior should be
   verified in integration tests against a live AppSync
   Events API.

3. **Connection sharing across channels** — When the
   Supabase client creates multiple channels (e.g.,
   `supabase.channel('a')` and `supabase.channel('b')`),
   the adapter should share a single WebSocket connection
   with multiple subscriptions. Verify AppSync supports
   different auth tokens per subscription on the same
   connection (documented: "Single WebSocket supports
   multiple subscriptions, even in different authorization
   modes").

4. **Presence heartbeat interval** — Supabase uses a 30s
   heartbeat and 60s timeout for presence. These values
   should be configurable but need sensible defaults that
   work within AppSync's 60s keepalive interval.

5. **Underscore-to-dash mapping reversibility** — The
   design maps underscores to dashes for AppSync channel
   segments (e.g., `user_profiles` becomes
   `user-profiles`). This is lossy: a table literally
   named `user-profiles` would collide with
   `user_profiles`. In practice, PostgreSQL table names
   use underscores and dashes are rare, so the risk is
   low. However, if this becomes a problem, an alternative
   is percent-encoding or a lookup table. For now the
   simple dash mapping is used.

6. **Batch publish optimization** — The publisher currently
   sends one event per HTTP request. AppSync allows up to
   5 events per request. A future optimization could batch
   multiple events from the same channel into a single
   request when the backend processes bulk writes (e.g.,
   multi-row INSERT). This is noted as a future
   optimization, not a Phase 1 requirement.

7. **`connection_init` behavior** — The design sends
   `connection_init` after opening the WebSocket. AWS
   documentation is ambiguous on whether this is strictly
   required or whether the server sends `connection_ack`
   automatically. Integration tests should verify both
   paths: with `connection_init` (expected to work) and
   without (to determine if it can be omitted).
