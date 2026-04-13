# events-lambda

Supabase-compatible real-time events on your own AWS account.

`events-lambda` is a two-part npm library that provides push notifications backed by [AWS AppSync Events](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-welcome.html). When data changes in the backend, subscribed clients receive updates instantly over WebSocket. Standard `@supabase/supabase-js` channel methods (`on('postgres_changes', ...)`, broadcast, presence) work out of the box.

## Why

Supabase Realtime parses the PostgreSQL WAL and evaluates every change against every subscriber's RLS policies. One INSERT with 100 subscribers means 100 RLS evaluations on a single thread. Aurora DSQL has no triggers, no LISTEN/NOTIFY, and no logical replication.

This library takes a different approach:

- **Application-layer publishing.** The backend publishes an event after each successful write. One publish per write, regardless of subscriber count.
- **AppSync Events handles fan-out.** No DynamoDB connection table, no cleanup Lambda, no custom WebSocket code. AppSync manages connections, subscriptions, and delivery at 1M outbound messages/second.
- **Database-agnostic.** Works with DSQL, Aurora, any PostgreSQL.

## Install

```bash
npm install events-lambda
```

For Node.js environments that need WebSocket support (tests, SSR):

```bash
npm install ws
```

## Quick Start

### 1. Publish events from your backend

After a successful database write, publish the change event:

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After INSERT
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: { id: 'abc', text: 'hello', user_id: 'u-1' },
});

// After UPDATE
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'UPDATE',
  newRow: { id: 'abc', text: 'updated' },
  oldRow: { id: 'abc', text: 'hello' },
});

// After DELETE
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'DELETE',
  oldRow: { id: 'abc', text: 'updated' },
});
```

`publishChange` is fire-and-forget. It never throws. If the HTTP POST to AppSync fails, the error is logged and the write response proceeds normally.

### 2. Subscribe from the client

Standard `@supabase/supabase-js` code works with no changes other than the realtime adapter config:

```javascript
import { createClient } from '@supabase/supabase-js';
import { createRealtimeAdapter } from 'events-lambda/adapter';

const supabase = createClient(apiUrl, anonKey, {
  realtime: createRealtimeAdapter({
    httpUrl: config.realtimeHttpUrl,
    wsUrl: config.realtimeWsUrl,
  })
});

// Subscribe to INSERT events on messages
supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New message:', payload.new)
  )
  .subscribe()
```

### 3. Deploy infrastructure

Add the AppSync Events API to your SAM template. See [Infrastructure Guide](docs/infrastructure.md) for the full template and deployment steps.

## Features

### Postgres Changes

Subscribe to INSERT, UPDATE, and DELETE events on specific tables.

```javascript
supabase.channel('db-changes')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => {
      // payload.new  — the inserted row
      // payload.old  — {} for inserts
      // payload.eventType — 'INSERT'
      // payload.commit_timestamp — ISO 8601
    }
  )
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'messages' },
    (payload) => {
      // Receives INSERT, UPDATE, and DELETE events
    }
  )
  .subscribe()
```

**Payload format** (matches Supabase):

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

### Broadcast

Client-to-client messaging that bypasses the database entirely. Both publish and subscribe use Cognito auth — no Lambda involved.

```javascript
const channel = supabase.channel('room1')

// Listen for events
channel.on('broadcast', { event: 'cursor-move' }, (payload) => {
  console.log('Cursor:', payload.payload)
})

// Subscribe, then send
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

### Presence (Phase 3)

Track which users are online and share ephemeral state. Uses a client-side CRDT approach. Implementation is deferred to a future release.

```javascript
// API will match Supabase:
channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState()
})
channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.track({ user: userId, online_at: new Date().toISOString() })
  }
})
```

## Channel Naming

AppSync Events channel segments allow `[A-Za-z0-9-]` only (no dots or underscores), max 50 characters per segment. The library maps names automatically:

| Supabase Concept | AppSync Channel |
|------------------|-------------------------------|
| `postgres_changes` INSERT on `public.messages` | `/db/public/messages/INSERT` |
| `postgres_changes` `*` on `public.messages` | `/db/public/messages/*` |
| `broadcast` event `cursor-move` on `room1` | `/broadcast/room1/cursor-move` |
| `presence` on `room1` | `/presence/room1` |

Underscores in table names and channel names are converted to dashes: `user_profiles` becomes `user-profiles` in the channel path. The original names are preserved in the event payload.

## Architecture

```
Client A (writer)         pgrest-lambda           AppSync Events         Client B (subscriber)
    |                         |                        |                        |
    | INSERT into messages    |                        |                        |
    |------------------------>|                        |                        |
    |                         | 1. Execute in DSQL     |                        |
    |                         | 2. publishChange() --->|                        |
    |                         |                        | broadcast ------------>|
    |  201 Created            |                        | {eventType: INSERT,    |
    |<------------------------|                        |  new: {...}}           |
```

**Auth model:**

| Namespace | Publish | Subscribe |
|-----------|---------|-----------|
| `/db/*` | IAM (Lambda only) | Cognito (user JWT) |
| `/broadcast/*` | Cognito (client) | Cognito (client) |
| `/presence/*` | Cognito (client) | Cognito (client) |

Clients cannot publish postgres_changes events directly. They write through the REST API, which triggers the publish.

## API Reference

- [Publisher API](docs/publisher-api.md) — `createEventPublisher`, `publishChange`, validation rules
- [Adapter API](docs/adapter-api.md) — `createRealtimeAdapter`, `RealtimeChannel`, WebSocket client
- [Infrastructure](docs/infrastructure.md) — SAM template, auth, IAM policies, deployment

## Configuration

### Environment Variables (Lambda)

| Variable | Description |
|----------|-------------|
| `APPSYNC_EVENTS_ENDPOINT` | AppSync Events HTTP endpoint (from SAM output) |
| `REGION_NAME` | AWS region for SigV4 signing. Use `REGION_NAME`, not `AWS_REGION` (reserved by Lambda runtime). |

### Adapter Config (Client)

| Option | Description |
|--------|-------------|
| `httpUrl` | AppSync Events HTTP domain (for auth headers) |
| `wsUrl` | AppSync Events WebSocket domain |
| `token` | Cognito JWT for authentication |

## Limits

| Limit | Value | Source |
|-------|-------|--------|
| Max event payload | 240 KB | AppSync Events |
| Max events per publish | 5 | AppSync Events |
| Channel segment length | 50 chars | AppSync Events |
| Channel segment count | 1-5 | AppSync Events |
| Keepalive interval | 60 seconds | AppSync Events |
| Max connection duration | 24 hours | AppSync Events |

## Companion Projects

- [pgrest-lambda](https://github.com/yoshuacas/pgrest-lambda) — PostgREST-compatible REST API + GoTrue-compatible auth
- [storage-lambda](https://github.com/yoshuacas/storage-lambda) — Supabase-compatible file storage on S3

Together they form a complete Supabase-equivalent backend on AWS.

## Development

```bash
# Run tests
npm test

# Run a single test file
node --test src/shared/protocol.test.mjs
```

Test suite: 77 tests across 5 files covering the shared protocol, publisher, WebSocket client, channel adapter, and broadcast.

## License

Apache License 2.0
