# AGENTS.md

Agent-oriented guide for working with `events-lambda`. This document explains how to set up each real-time capability, provides copy-paste examples, and covers the patterns that trip people up.

## Overview

`events-lambda` has two entry points:

```javascript
// Server-side (runs on Lambda)
import { createEventPublisher } from 'events-lambda';

// Client-side (runs in browser or Node)
import { createRealtimeAdapter } from 'events-lambda/adapter';
```

The publisher sends events to AppSync Events via signed HTTP POST. The adapter translates `@supabase/supabase-js` realtime calls into AppSync Events WebSocket subscriptions.

## Setting Up the Publisher

The publisher runs on Lambda (or any Node.js backend). It needs the AppSync Events HTTP endpoint and the AWS region.

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,  // never AWS_REGION (reserved by Lambda)
});
```

The publisher signs requests with IAM SigV4 using the Lambda execution role's credentials. No API keys or tokens needed server-side.

### Publishing After Database Writes

The standard pattern: execute the database write, then publish. The publish is fire-and-forget — it never throws and never blocks the response.

```javascript
// In your request handler, after a successful INSERT:
const result = await db.query('INSERT INTO messages (text, user_id) VALUES ($1, $2) RETURNING *', [text, userId]);
const row = result.rows[0];

await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: row,
});

// Return the response immediately — don't wait for subscribers
return { statusCode: 201, body: JSON.stringify(row) };
```

### All Three Event Types

```javascript
// INSERT — newRow required, oldRow omitted
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: { id: '1', text: 'hello', user_id: 'u-1' },
});

// UPDATE — both newRow and oldRow required
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'UPDATE',
  newRow: { id: '1', text: 'updated', user_id: 'u-1' },
  oldRow: { id: '1', text: 'hello', user_id: 'u-1' },
});

// DELETE — oldRow required, newRow omitted
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'DELETE',
  oldRow: { id: '1', text: 'updated', user_id: 'u-1' },
});
```

### Validation Rules

The publisher validates inputs before sending. If validation fails, the error is logged and the publish is skipped (no throw).

| Field | Rule |
|-------|------|
| `event` | Must be `'INSERT'`, `'UPDATE'`, or `'DELETE'`. Not `'*'`. |
| `table` | Required, non-empty. After underscore-to-dash mapping, must match `[A-Za-z0-9-]+` and be at most 50 characters. |
| `schema` | Optional (default: `'public'`). Same character/length rules as table. |
| `newRow` | Required for INSERT and UPDATE. Must be a non-null object. |
| `oldRow` | Required for UPDATE and DELETE. Must be a non-null object. |
| Payload size | Serialized event must not exceed 240 KB. |

### Table Names with Underscores

PostgreSQL table names commonly use underscores (`user_profiles`, `chat_messages`). AppSync channel segments don't allow underscores. The library maps them to dashes automatically:

```javascript
await publisher.publishChange({
  table: 'user_profiles',  // input
  event: 'INSERT',
  newRow: row,
});
// Publishes to channel: /db/public/user-profiles/INSERT
// Payload still contains: { table: 'user_profiles', ... }
```

The mapping is consistent between publisher and adapter — both call the same `sanitizeSegment()` function.

## Setting Up the Client Adapter

The adapter plugs into `@supabase/supabase-js` as a custom realtime provider.

```javascript
import { createClient } from '@supabase/supabase-js';
import { createRealtimeAdapter } from 'events-lambda/adapter';

const supabase = createClient(apiUrl, anonKey, {
  realtime: createRealtimeAdapter({
    httpUrl: 'example.appsync-api.us-east-1.amazonaws.com',
    wsUrl: 'wss://example.appsync-realtime-api.us-east-1.amazonaws.com',
    token: cognitoIdToken,  // Cognito JWT
  })
});
```

The `httpUrl` and `wsUrl` come from the SAM template outputs (`RealtimeHttpEndpoint` and `RealtimeWsEndpoint`).

## Postgres Changes: Complete Setup

This is the most common use case. A client subscribes to database change events that the backend publishes.

### Server Side

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After each successful write:
export async function handleInsert(table, row) {
  await publisher.publishChange({
    schema: 'public',
    table,
    event: 'INSERT',
    newRow: row,
  });
}

export async function handleUpdate(table, newRow, oldRow) {
  await publisher.publishChange({
    schema: 'public',
    table,
    event: 'UPDATE',
    newRow,
    oldRow,
  });
}

export async function handleDelete(table, oldRow) {
  await publisher.publishChange({
    schema: 'public',
    table,
    event: 'DELETE',
    oldRow,
  });
}
```

### Client Side

```javascript
// Subscribe to INSERT events on a specific table
const channel = supabase.channel('messages-inserts')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => {
      console.log('New message:', payload.new);
      console.log('Event type:', payload.eventType);    // 'INSERT'
      console.log('Timestamp:', payload.commit_timestamp);
    }
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Listening for new messages');
    }
  });
```

### Subscribe to All Events on a Table

Use `event: '*'` to receive INSERT, UPDATE, and DELETE:

```javascript
supabase.channel('all-changes')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'messages' },
    (payload) => {
      switch (payload.eventType) {
        case 'INSERT':
          addMessage(payload.new);
          break;
        case 'UPDATE':
          updateMessage(payload.new, payload.old);
          break;
        case 'DELETE':
          removeMessage(payload.old);
          break;
      }
    }
  )
  .subscribe()
```

Under the hood, `event: '*'` subscribes to `/db/public/messages/*` (AppSync wildcard). The adapter extracts `eventType` from the payload to determine the specific event.

### Multiple Listeners on One Channel

A single Supabase channel can listen to multiple tables or event types. Each `on()` call creates a separate AppSync subscription.

```javascript
supabase.channel('dashboard')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    handleNewMessage
  )
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'users' },
    handleNewUser
  )
  .on('postgres_changes',
    { event: 'DELETE', schema: 'public', table: 'messages' },
    handleDeletedMessage
  )
  .subscribe()
```

### Unsubscribe

```javascript
// Remove a specific channel
await supabase.removeChannel(channel);

// Or unsubscribe directly
await channel.unsubscribe();
```

## Broadcast: Complete Setup

Broadcast is client-to-client messaging. Messages flow through AppSync Events without touching the database or Lambda. Both publish and subscribe use Cognito auth.

### Basic Chat Room

```javascript
const channel = supabase.channel('room-42')

// Listen for messages
channel.on('broadcast', { event: 'message' }, (payload) => {
  console.log(`${payload.payload.user}: ${payload.payload.text}`);
})

// Subscribe first, then send
channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    // Send a message
    channel.send({
      type: 'broadcast',
      event: 'message',
      payload: { user: 'alice', text: 'Hello!' }
    })
  }
})
```

### Cursor Tracking

```javascript
const channel = supabase.channel('collab-doc')

// Listen for cursor moves
channel.on('broadcast', { event: 'cursor' }, (payload) => {
  moveCursor(payload.payload.userId, payload.payload.x, payload.payload.y);
})

channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    // Send cursor position on mouse move
    document.addEventListener('mousemove', (e) => {
      channel.send({
        type: 'broadcast',
        event: 'cursor',
        payload: { userId: myId, x: e.clientX, y: e.clientY }
      })
    })
  }
})
```

### Multiple Event Types

```javascript
const channel = supabase.channel('room-42')

channel.on('broadcast', { event: 'message' }, handleMessage)
channel.on('broadcast', { event: 'typing' }, handleTyping)
channel.on('broadcast', { event: 'reaction' }, handleReaction)

channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    channel.send({ type: 'broadcast', event: 'typing', payload: { user: 'alice' } })
    channel.send({ type: 'broadcast', event: 'message', payload: { text: 'Hi' } })
  }
})
```

### Broadcast Channel Naming

Broadcast event names follow the same rules as all AppSync channel segments:

```javascript
// These work:
channel.on('broadcast', { event: 'cursor-move' }, cb)
channel.on('broadcast', { event: 'typing' }, cb)
channel.on('broadcast', { event: 'user-joined' }, cb)

// These will throw (invalid characters):
channel.on('broadcast', { event: 'cursor.move' }, cb)   // dots not allowed
channel.on('broadcast', { event: 'user@joined' }, cb)    // @ not allowed

// Underscores are mapped to dashes:
channel.on('broadcast', { event: 'cursor_move' }, cb)
// Subscribes to /broadcast/{channel}/cursor-move
```

### Broadcast Payload Size

The entire serialized event (including the `{event, payload, type}` wrapper) must not exceed 240 KB. Oversized payloads are silently dropped.

## Combining Postgres Changes and Broadcast

A common pattern: subscribe to database changes for the data model, and use broadcast for ephemeral state.

```javascript
const channel = supabase.channel('room-42')

// Database changes (server-published)
channel.on('postgres_changes',
  { event: 'INSERT', schema: 'public', table: 'messages' },
  (payload) => addMessage(payload.new)
)

// Typing indicator (client-published)
channel.on('broadcast',
  { event: 'typing' },
  (payload) => showTyping(payload.payload.user)
)

channel.subscribe((status) => {
  if (status === 'SUBSCRIBED') {
    // Start sending typing indicators
    inputEl.addEventListener('input', () => {
      channel.send({
        type: 'broadcast',
        event: 'typing',
        payload: { user: currentUser }
      })
    })
  }
})
```

## Presence: Setup (Phase 3)

Presence is deferred to a future release. The API will match Supabase:

```javascript
const channel = supabase.channel('room-42')

channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState()
  // { 'user-1': [{ online_at: '...', status: 'active' }], ... }
  updateOnlineUsers(state)
})

channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
  console.log('Joined:', key, newPresences)
})

channel.on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
  console.log('Left:', key, leftPresences)
})

channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.track({
      user: userId,
      online_at: new Date().toISOString(),
      status: 'active'
    })
  }
})
```

## Row-Level Filtering (Phase 4)

Client-side filter evaluation is planned for Phase 4. The API will match Supabase:

```javascript
supabase.channel('room-messages')
  .on('postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: 'room_id=eq.42'
    },
    (payload) => {
      // Only fires for messages where room_id = 42
    }
  )
  .subscribe()
```

Supported filter operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`.

Until Phase 4 lands, all events for the table are delivered. Filter on the client manually:

```javascript
supabase.channel('room-messages')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => {
      if (payload.new.room_id === 42) {
        handleNewMessage(payload.new);
      }
    }
  )
  .subscribe()
```

## Infrastructure Setup

The library requires an AppSync Events API deployed via SAM or CloudFormation. See [docs/infrastructure.md](docs/infrastructure.md) for the full template.

Minimum viable setup:

```yaml
# AppSync Events API
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

Add the endpoint as a Lambda environment variable:

```yaml
Environment:
  Variables:
    APPSYNC_EVENTS_ENDPOINT: !GetAtt RealtimeApi.Dns.Http
    APPSYNC_EVENTS_REALTIME: !GetAtt RealtimeApi.Dns.Realtime
```

Grant the Lambda publish permission:

```yaml
- Statement:
    - Effect: Allow
      Action:
        - appsync:EventPublish
      Resource:
        - !Sub "arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${RealtimeApi.ApiId}/*"
```

## Error Handling

### Publisher

`publishChange()` never throws. All errors are caught and logged to `console.error`. The write response always proceeds.

```javascript
// This will log an error but won't throw:
await publisher.publishChange({
  table: 'messages',
  event: 'INVALID',  // not INSERT/UPDATE/DELETE
  newRow: {},
});
// Console: events-lambda: publish failed Error: event must be INSERT, UPDATE, or DELETE
```

### Adapter

The adapter reports errors through the status callback:

```javascript
channel.subscribe((status, error) => {
  switch (status) {
    case 'SUBSCRIBED':
      console.log('Connected and listening');
      break;
    case 'CHANNEL_ERROR':
      console.error('Subscription failed:', error);
      // Common cause: Cognito token lacks authorization
      // for this channel (Cedar policy denial)
      break;
    case 'TIMED_OUT':
      console.error('Connection timed out');
      break;
    case 'CLOSED':
      console.log('Channel closed');
      break;
  }
});
```

Validation errors (invalid channel names, oversized payloads) throw during `on()` or `subscribe()`:

```javascript
try {
  channel.on('broadcast', { event: 'bad.name' }, cb);  // dot in name
  await channel.subscribe();
} catch (err) {
  // "bad.name" contains characters not allowed in AppSync channel segments
}
```

## Common Patterns

### Wrap Publisher in a Middleware

```javascript
function withRealtime(publisher) {
  return async function publishAfterWrite(schema, table, event, newRow, oldRow) {
    await publisher.publishChange({ schema, table, event, newRow, oldRow });
  };
}

const publish = withRealtime(publisher);

// In your handler:
const row = await db.insert('messages', data);
await publish('public', 'messages', 'INSERT', row, null);
```

### React Hook for Supabase Channel

```javascript
import { useEffect, useState } from 'react';

function useRealtimeMessages(supabase, table) {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    const channel = supabase.channel(`${table}-changes`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table },
        (payload) => setMessages(prev => [...prev, payload.new])
      )
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table },
        (payload) => setMessages(prev =>
          prev.filter(m => m.id !== payload.old.id)
        )
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [supabase, table]);

  return messages;
}
```

### Multiple Tables in One Channel

```javascript
const channel = supabase.channel('app-events')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'messages' },
    (payload) => handleMessages(payload)
  )
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'users' },
    (payload) => handleUsers(payload)
  )
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'notifications' },
    (payload) => showNotification(payload.new)
  )
  .subscribe()
```

Each `on()` call creates a separate AppSync subscription. All subscriptions share a single WebSocket connection.

## Troubleshooting

### "contains characters not allowed in AppSync channel segments"

Table names, schema names, channel names, and broadcast event names can only contain `[A-Za-z0-9_-]`. Underscores are mapped to dashes. Any other characters (dots, spaces, special characters) cause this error.

### Events not arriving at subscribers

1. Verify the publisher is using the same channel naming as the adapter. Both import from `shared/protocol.mjs`, so they should agree. Check that the table name matches exactly (case-sensitive).
2. Verify the Lambda has `appsync:EventPublish` permission.
3. Verify the Cognito token is valid and authorized for the channel.
4. Check the publisher logs — `publishChange` logs errors to `console.error`.

### "Subscribe failed: Unauthorized"

The Cognito JWT lacks authorization for the requested channel. This is enforced by Cedar policies on the AppSync Events API. Verify the user's role has subscribe access to the channel namespace.

### Payload too large

The serialized event payload (including all wrapper fields) must not exceed 240 KB. For large rows, consider publishing only the fields subscribers need, or publish a notification with the row ID and let the client fetch the full row via REST.

### WebSocket not connecting

- Verify `wsUrl` uses the `wss://` scheme and points to the AppSync Events realtime domain.
- Verify the Cognito token is not expired (default: 1 hour).
- Check browser dev tools for WebSocket errors.

## Channel Naming Reference

| Segment | Allowed Characters | Max Length |
|---------|-------------------|------------|
| Namespace | `[A-Za-z0-9-]` | 50 |
| Schema | `[A-Za-z0-9-]` (after underscore mapping) | 50 |
| Table | `[A-Za-z0-9-]` (after underscore mapping) | 50 |
| Event | `INSERT`, `UPDATE`, `DELETE`, `*` | N/A |
| Broadcast event | `[A-Za-z0-9-]` | 50 |
| Channel name | `[A-Za-z0-9-]` (after underscore mapping) | 50 |

Maximum 5 segments per channel path. Current usage:
- postgres_changes: 4 segments (`db` / schema / table / event)
- broadcast: 3 segments (`broadcast` / channel / event)
- presence: 2 segments (`presence` / channel)
