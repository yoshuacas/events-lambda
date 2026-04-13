# events-lambda: Supabase-Compatible Real-Time Events on AppSync Events

## Problem

`@supabase/supabase-js` provides a real-time API where clients subscribe to database changes, broadcast messages, and track presence. Supabase Realtime implements this with an Elixir server that parses the PostgreSQL WAL — heavyweight, Postgres-specific, and impossible to run on Lambda.

Aurora DSQL (BOA's database) has no triggers, no LISTEN/NOTIFY, and no logical replication. We need real-time events powered by a different mechanism.

## Solution

A two-part npm library:

1. **Server-side publisher** — called by pgrest-lambda after successful writes, publishes events to AppSync Events via HTTP POST
2. **Client-side adapter** — translates `@supabase/supabase-js` realtime API into AppSync Events WebSocket subscriptions

AppSync Events (launched October 2024, updated April 2025) handles all WebSocket complexity: connection management, channel subscriptions, fan-out to subscribers. No DynamoDB connection table, no custom WebSocket code.

## Why AppSync Events (Not API Gateway WebSocket)

| Concern | API GW WebSocket | AppSync Events |
|---------|-------------------|----------------|
| Connection management | DIY (DynamoDB table, cleanup Lambda) | Managed |
| Fan-out | DIY (scan + post to each connection) | Native (1M outbound msg/sec) |
| Connection cost/M min | $0.25 | $0.08 |
| Message cost/M | $1.00 (32KB frames) | $1.00 |
| Auth | Custom authorizer | Cognito, IAM, Lambda, OIDC built-in |
| Channel subscriptions | DIY | Native with wildcards |
| Bidirectional | Yes | Yes (since April 2025) |
| EventBridge integration | Manual | Native |

AppSync Events eliminates ~300 lines of connection management code and is 3x cheaper for connection minutes.

## Why Application-Layer Events (Not WAL)

Supabase parses the Postgres WAL and evaluates every change against every subscriber's RLS policies. One INSERT with 100 subscribers = 100 RLS evaluations on a single thread. This is their documented scaling bottleneck.

BOA's approach — publishing from the application layer after a successful write:

- **Explicit** — only publishes for operations that go through the API
- **Efficient** — one publish per write, not per subscriber (AppSync handles fan-out)
- **Database-agnostic** — works with DSQL, Aurora, any PostgreSQL
- **No database load** — no replication slot, no WAL parsing overhead
- **Cedar evaluation happens once** at write time, not per subscriber

**Tradeoff:** Direct database modifications (psql, migration scripts) don't trigger events. This is acceptable — those are admin operations. If needed, a future DSQL audit log integration could catch out-of-band changes.

## Supabase Realtime Feature Mapping

### Feature 1: Postgres Changes

Subscribe to INSERT, UPDATE, DELETE events on specific tables.

**Supabase client API (what developers write):**
```javascript
supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => {
      console.log('New message:', payload.new)
    }
  )
  .on('postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'room_id=eq.123' },
    (payload) => {
      console.log('Updated:', payload.old, '→', payload.new)
    }
  )
  .subscribe()
```

**Payload format (must match Supabase):**
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

**Channel mapping:**
```
supabase.channel().on('postgres_changes', {event: 'INSERT', table: 'messages'})
  → AppSync Events subscribe to: /db/public.messages.INSERT

supabase.channel().on('postgres_changes', {event: '*', table: 'messages'})
  → AppSync Events subscribe to: /db/public.messages/*
```

**Server-side publish (inside pgrest-lambda):**
```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After INSERT succeeds:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: result.rows[0],
  oldRow: null,
});

// After UPDATE succeeds:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'UPDATE',
  newRow: result.rows[0],
  oldRow: previousRow,
});

// After DELETE succeeds:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'DELETE',
  newRow: null,
  oldRow: deletedRow,
});
```

**Implementation — publisher side (~80 lines):**
```javascript
// src/publisher/appsync-client.mjs
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

export class AppSyncEventsClient {
  constructor({ apiEndpoint, region }) {
    this.endpoint = apiEndpoint;  // https://{id}.appsync-api.{region}.amazonaws.com
    this.region = region;
  }

  async publish(channel, events) {
    const body = JSON.stringify({
      channel,
      events: events.map(e => JSON.stringify(e)),
    });

    // IAM SigV4 signed request
    const request = {
      method: 'POST',
      hostname: new URL(this.endpoint).hostname,
      path: '/event',
      headers: { 'Content-Type': 'application/json', host: new URL(this.endpoint).hostname },
      body,
    };

    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region: this.region,
      service: 'appsync',
      sha256: Sha256,
    });

    const signed = await signer.sign(request);
    const response = await fetch(this.endpoint + '/event', {
      method: 'POST',
      headers: signed.headers,
      body,
    });

    if (!response.ok) {
      console.error('AppSync publish failed:', response.status, await response.text());
    }
  }
}
```

### Feature 2: Broadcast

Client-to-client pub/sub. Messages don't go through the database — they're relayed directly through AppSync Events.

**Supabase client API:**
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

**Channel mapping:**
```
channel.send({type: 'broadcast', event: 'cursor-move'})
  → AppSync Events publish to: /broadcast/room1.cursor-move

channel.on('broadcast', {event: 'cursor-move'})
  → AppSync Events subscribe to: /broadcast/room1.cursor-move
```

**Implementation:** Broadcast is the simplest feature — it's pure AppSync Events pub/sub. The client adapter translates channel names and the payload format. Both publish and subscribe use Cognito auth (clients publish directly, no Lambda involved).

### Feature 3: Presence

Track which users are online and share ephemeral state (typing indicators, cursor positions).

**Supabase client API:**
```javascript
const channel = supabase.channel('room1')

channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState()
  // { 'user-1': [{ online_at: '...', status: 'active' }], ... }
})

channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
  console.log('Joined:', key, newPresences)
})

channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
  console.log('Left:', key, leftPresences)
})

channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.track({ user: userId, online_at: new Date().toISOString() })
  }
})
```

**Implementation — P2 (defer to later phase):**

Presence requires tracking state across multiple clients. Two approaches:

**Option A: Client-side CRDT (like Supabase)**
- Each client broadcasts its presence on join/heartbeat
- Each client maintains a local map of all presences
- On disconnect (no heartbeat for N seconds), remove from local map
- Pro: no server state, simple
- Con: eventual consistency, stale presences until timeout

**Option B: DynamoDB TTL table**
- Client tracks presence → Lambda writes `{userId, channelId, state, ttl}` to DynamoDB
- DynamoDB TTL auto-deletes expired entries
- Periodic sync broadcasts current state to channel
- Pro: authoritative state, clean expiry
- Con: adds DynamoDB, more infrastructure

**Recommendation:** Option A for v1 (client-side, same as Supabase). Presence is inherently ephemeral — eventual consistency is fine.

### Row-Level Filtering

Supabase supports filters on subscriptions: `filter: 'room_id=eq.123'`. This means only matching rows trigger the callback.

**Implementation:** Two options:

**Option A: Publish all, filter on client**
- Publisher sends every change for the table
- Client adapter filters locally against the subscription filter
- Pro: simple publisher, no per-subscriber logic
- Con: clients receive events they discard (bandwidth waste for high-volume tables)

**Option B: Granular channels**
- Publisher includes filter-relevant values in channel name: `/db/public.messages.INSERT.room_id.123`
- Client subscribes to the specific channel
- Pro: clients only receive relevant events
- Con: channel explosion for many filter values, AppSync 50-char segment limit

**Recommendation:** Option A for v1. Most apps have low enough write volume that client-side filtering is fine. The publish is a single event per write regardless of subscriber count (AppSync handles fan-out). For high-volume tables in v2, add server-side filtering via AppSync Event handlers (JavaScript runtime that can filter before delivery).

## SAM Template Integration

AppSync Events API added to the BOA backend template:

```yaml
# ---- Real-Time Events (AppSync Events) ----

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
      ChannelNamespaces:
        - Name: db
        - Name: broadcast
        - Name: presence

RealtimeApiKey:
  Type: AWS::AppSync::ApiKey
  Properties:
    ApiId: !GetAtt RealtimeApi.ApiId
    Description: "Realtime API key for anonymous access"
    Expires: !Ref ApiKeyExpiration
```

**Environment variables added to the API Lambda:**
```yaml
Environment:
  Variables:
    APPSYNC_EVENTS_ENDPOINT: !GetAtt RealtimeApi.Dns.Http
    APPSYNC_EVENTS_REALTIME: !GetAtt RealtimeApi.Dns.Realtime
```

**IAM policy for the API Lambda (publish only):**
```yaml
- Statement:
    - Effect: Allow
      Action:
        - appsync:EventPublish
      Resource:
        - !Sub "arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${RealtimeApi.ApiId}/*"
```

**Outputs added to .boa/config.json:**
```json
{
  "realtimeHttpUrl": "https://{id}.appsync-api.{region}.amazonaws.com",
  "realtimeWsUrl": "wss://{id}.appsync-realtime-api.{region}.amazonaws.com"
}
```

## Client Adapter Design

The adapter replaces `@supabase/realtime-js` to route through AppSync Events instead of Supabase's Elixir server.

### Integration with @supabase/supabase-js

```javascript
import { createClient } from '@supabase/supabase-js';
import { createRealtimeAdapter } from 'events-lambda/adapter';

const supabase = createClient(apiUrl, anonKey, {
  realtime: createRealtimeAdapter({
    httpUrl: realtimeHttpUrl,   // from .boa/config.json
    wsUrl: realtimeWsUrl,       // from .boa/config.json
    // Auth token is passed through from supabase client automatically
  })
});

// Now standard Supabase realtime code works:
supabase.channel('room1')
  .on('postgres_changes', { event: 'INSERT', table: 'messages' }, callback)
  .subscribe()
```

### WebSocket Connection

The adapter connects to AppSync Events WebSocket endpoint using the Cognito JWT:

```
wss://{id}.appsync-realtime-api.{region}.amazonaws.com/event/realtime
```

Connection is established with the Cognito access token in the authorization header. AppSync validates the token against the same User Pool the REST API uses.

### Channel Name Mapping

| Supabase Concept | AppSync Events Channel |
|------------------|----------------------|
| `postgres_changes` INSERT on `messages` | `/db/public.messages.INSERT` |
| `postgres_changes` `*` on `messages` | `/db/public.messages/*` |
| `broadcast` event `cursor` on channel `room1` | `/broadcast/room1.cursor` |
| `presence` on channel `room1` | `/presence/room1` |

### Payload Transformation

AppSync Events delivers raw JSON. The adapter transforms it into the Supabase payload format before calling the developer's callback:

```javascript
// AppSync Events delivers:
{ "channel": "/db/public.messages.INSERT", "event": "{...json...}" }

// Adapter transforms to Supabase format:
{
  schema: 'public',
  table: 'messages',
  commit_timestamp: '2026-04-12T18:00:00Z',
  eventType: 'INSERT',
  new: { id: 'abc', text: 'hello', user_id: 'user-123' },
  old: {},
  errors: null
}
```

## Dependencies

### Server-side publisher (Lambda)
```json
{
  "@aws-sdk/credential-provider-node": "^3.0.0",
  "@aws-crypto/sha256-js": "^5.0.0",
  "@smithy/signature-v4": "^3.0.0"
}
```

Lightweight — only AWS SDK signing utilities. No Cognito, no pg, no Cedar (those are in pgrest-lambda which calls this library).

### Client-side adapter (browser)
```json
{
  // Zero runtime dependencies — uses native WebSocket API
}
```

The adapter uses the browser's native `WebSocket` API. No additional libraries needed. For Node.js environments, a WebSocket polyfill (`ws`) is a peer dependency.

## Implementation Phases

### Phase 1: Postgres Changes (P0)
- Server-side publisher: `publishChange()` method
- AppSync Events HTTP client with IAM SigV4 signing
- Client adapter: `on('postgres_changes', ...)` subscription
- AppSync Events WebSocket client with Cognito auth
- Channel naming convention and payload transformation
- SAM template snippet for AppSync Events API
- Integration test: write via REST → receive via WebSocket

### Phase 2: Broadcast (P0)
- Client adapter: `send({type: 'broadcast', ...})` publish
- Client adapter: `on('broadcast', ...)` subscribe
- Both directions use Cognito auth (client-to-client, no Lambda)
- Integration test: client A sends → client B receives

### Phase 3: Presence (P2)
- Client-side CRDT presence state
- `track()`, `untrack()`, `presenceState()` methods
- `join` and `leave` events via heartbeat + timeout
- Integration test: client A tracks → client B sees join → client A disconnects → client B sees leave

### Phase 4: Row-Level Filtering (P1)
- Client-side filter evaluation against incoming events
- Filter syntax: `column=eq.value`, `column=in.(a,b,c)`
- Skip callback for non-matching events

### Phase 5: Hardening
- Reconnection with exponential backoff
- Missed message detection (sequence numbers)
- Cedar policy evaluation for subscribe permissions
- Rate limiting on publish (prevent event storms)
- Integration tests against real AppSync Events + DSQL

## Success Criteria

1. `@supabase/supabase-js` `channel()` API works with zero client code changes (only config)
2. INSERT/UPDATE/DELETE events arrive at subscribers within 200ms of write
3. Broadcast messages arrive within 100ms
4. Publisher adds less than 50ms latency to write responses
5. Zero connection management code — AppSync handles everything
6. Client adapter is under 5KB minified (browser bundle)
7. Server publisher is under 3KB (Lambda cold start impact negligible)
