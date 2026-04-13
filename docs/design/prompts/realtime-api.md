Supabase-compatible real-time events on AppSync Events

## Context

events-lambda is a two-part npm library:

1. **Server-side publisher** — called by pgrest-lambda after successful writes, publishes events to AppSync Events via HTTP POST with IAM SigV4 signing
2. **Client-side adapter** — translates `@supabase/supabase-js` realtime API (`channel()`, `on('postgres_changes', ...)`, broadcast, presence) into AppSync Events WebSocket subscriptions

AppSync Events handles all WebSocket complexity: connection management, channel subscriptions, fan-out to subscribers. No DynamoDB connection table, no custom WebSocket code.

Events are published from the application layer after successful writes — not from database triggers, WAL, or LISTEN/NOTIFY. One publish per write, AppSync handles fan-out.

## Features to Implement

### Feature 1: Postgres Changes (P0)

Subscribe to INSERT, UPDATE, DELETE events on specific tables.

Client API (standard Supabase code):
```javascript
supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New message:', payload.new)
  )
  .subscribe()
```

Payload format (must match Supabase):
```json
{
  "schema": "public",
  "table": "messages",
  "commit_timestamp": "2026-04-12T18:00:00Z",
  "eventType": "INSERT",
  "new": { "id": "abc", "text": "hello", "user_id": "user-123" },
  "old": {},
  "errors": null
}
```

Channel mapping:
- `on('postgres_changes', {event: 'INSERT', table: 'messages'})` → `/db/public.messages.INSERT`
- `on('postgres_changes', {event: '*', table: 'messages'})` → `/db/public.messages/*`

Server-side publisher API:
```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: result.rows[0],
  oldRow: null,
});
```

Publisher implementation uses IAM SigV4 signed HTTP POST to AppSync Events `/event` endpoint. Fire-and-forget — publish failure must not block the write response.

### Feature 2: Broadcast (P0)

Client-to-client pub/sub. Messages don't go through the database — relayed directly through AppSync Events.

```javascript
const channel = supabase.channel('room1')
channel.on('broadcast', { event: 'cursor-move' }, (payload) => {
  console.log('Cursor:', payload.payload)
})
channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    channel.send({ type: 'broadcast', event: 'cursor-move', payload: { x: 100, y: 200 } })
  }
})
```

Channel mapping:
- `send({type: 'broadcast', event: 'cursor-move'})` → publish to `/broadcast/room1.cursor-move`
- `on('broadcast', {event: 'cursor-move'})` → subscribe to `/broadcast/room1.cursor-move`

Both publish and subscribe use Cognito auth (client-to-client, no Lambda involved).

### Feature 3: Presence (P2 — defer to later phase)

Track which users are online and share ephemeral state. Use client-side CRDT approach (same as Supabase): each client broadcasts presence on join/heartbeat, maintains a local map, removes after timeout.

```javascript
channel.on('presence', { event: 'sync' }, () => { const state = channel.presenceState() })
channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {})
channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {})
channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') await channel.track({ user: userId, online_at: new Date().toISOString() })
})
```

### Feature 4: Row-Level Filtering (P1)

Client-side filter evaluation against incoming events. Filter syntax: `column=eq.value`, `column=in.(a,b,c)`. Publish all events for the table, filter on client before invoking callback.

## Channel Naming Convention (contract between publisher and adapter)

| Supabase Concept | AppSync Events Channel |
|------------------|----------------------|
| postgres_changes INSERT on messages | `/db/public.messages.INSERT` |
| postgres_changes * on messages | `/db/public.messages/*` |
| broadcast event cursor on channel room1 | `/broadcast/room1.cursor` |
| presence on channel room1 | `/presence/room1` |

## Infrastructure

AppSync Events API declared in SAM template:
- Auth providers: Cognito (subscribe) + IAM (publish for postgres_changes)
- Channel namespaces: `db`, `broadcast`, `presence`
- Lambda execution role gets `appsync:EventPublish` permission
- Broadcast namespace allows Cognito publish (client-to-client)

Environment variables: `APPSYNC_EVENTS_ENDPOINT`, `APPSYNC_EVENTS_REALTIME`

## Dependencies

Server-side (Lambda): `@aws-sdk/credential-provider-node`, `@aws-crypto/sha256-js`, `@smithy/signature-v4`
Client-side (browser): zero runtime dependencies (native WebSocket API). `ws` is an optional peer dep for Node.js.

## Implementation Phases

1. **Phase 1 (P0):** Postgres Changes — publisher + adapter + SAM template + tests
2. **Phase 2 (P0):** Broadcast — client-to-client pub/sub + tests
3. **Phase 3 (P2):** Presence — client-side CRDT + tests
4. **Phase 4 (P1):** Row-Level Filtering — client-side filter evaluation + tests
5. **Phase 5:** Hardening — reconnection, missed message detection, Cedar policies, rate limiting

## Target File Structure

```
src/
├── publisher/
│   ├── index.mjs          # createEventPublisher() factory
│   ├── appsync-client.mjs # AppSync Events HTTP publish client
│   ├── channel-map.mjs    # Maps table+action → channel name
│   └── filter.mjs         # Optional: skip publish if no subscribers
├── adapter/
│   ├── index.mjs          # Entry point, patches supabase realtime
│   ├── channel.mjs        # Supabase channel API implementation
│   ├── websocket.mjs      # AppSync Events WebSocket client
│   ├── presence.mjs       # Presence state management
│   └── broadcast.mjs      # Client-to-client broadcast
└── shared/
    ├── protocol.mjs       # Channel naming conventions, payload format
    └── errors.mjs         # Error codes
```

## Success Criteria

1. `@supabase/supabase-js` `channel()` API works with zero client code changes (only config)
2. INSERT/UPDATE/DELETE events arrive within 200ms of write
3. Broadcast messages arrive within 100ms
4. Publisher adds less than 50ms latency to write responses
5. Zero connection management code — AppSync handles everything
6. Client adapter under 5KB minified
7. Server publisher under 3KB
