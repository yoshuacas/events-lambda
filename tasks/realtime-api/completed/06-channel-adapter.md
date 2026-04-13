# Task 06: Channel Adapter

Agent: implementer
Design: docs/design/realtime-api.md
Depends on: Task 02, Task 05

## Objective

Implement the Supabase-compatible `RealtimeChannel` class
and `createRealtimeAdapter` factory for postgres_changes
subscriptions.

## Target Tests

From `src/adapter/channel.test.mjs`:
- on postgres_changes registers subscription to correct
  channel
- on postgres_changes with wildcard event registers
  wildcard channel
- subscribe opens WebSocket and sends subscribe messages
- subscribe callback receives SUBSCRIBED on success
- subscribe callback receives CHANNEL_ERROR on failure
- unsubscribe sends unsubscribe for all subscriptions
- subscribe is idempotent
- incoming data is routed to correct callback
- multiple on() listeners produce separate subscriptions
- on postgres_changes with table containing underscores
- createRealtimeAdapter returns object with channel method
- removeChannel unsubscribes and cleans up

## Implementation

### src/adapter/channel.mjs

Create the `RealtimeChannel` class:

```javascript
import { pgChangesChannel, broadcastChannel }
  from '../shared/protocol.mjs';

export class RealtimeChannel {
  constructor(name, wsClient, httpUrl) {
    this.name = name;
    this.wsClient = wsClient;
    this.httpUrl = httpUrl;
    this.listeners = [];    // {type, filter, callback, channel, subId}
    this.subscribed = false;
  }

  on(type, filter, callback) {
    let channel;
    if (type === 'postgres_changes') {
      const { event, schema = 'public', table } = filter;
      channel = pgChangesChannel(schema, table, event);
    } else if (type === 'broadcast') {
      channel = broadcastChannel(this.name, filter.event);
    }
    this.listeners.push({ type, filter, callback, channel, subId: null });
    return this;  // chainable
  }

  async subscribe(statusCallback) {
    if (this.subscribed) return;
    this.subscribed = true;
    try {
      // Connect if not already connected
      // For each listener, call wsClient.subscribe()
      // Store returned subscription ID in listener.subId
      // On all success: statusCallback?.('SUBSCRIBED')
    } catch (err) {
      statusCallback?.('CHANNEL_ERROR');
    }
  }

  async send(message) {
    // Handled in Task 07 (broadcast)
  }

  async unsubscribe() {
    // For each listener with a subId:
    //   call wsClient.unsubscribe(subId)
    // Reset subscribed state
  }
}
```

Key behaviors:
- `on()` is chainable (returns `this`).
- Each `on()` call maps to a separate AppSync subscription
  with its own ID.
- `subscribe()` is idempotent: calling it twice does not
  send duplicate subscribe messages.
- When a `data` message arrives, the WebSocket client
  routes it to the callback registered for that
  subscription ID. The channel class provides the callback
  to the WebSocket client during subscribe.
- For wildcard subscriptions (`event: '*'`), the adapter
  subscribes to `/db/{schema}/{table}/*`. The event type
  is determined from the payload's `eventType` field when
  data arrives.

### src/adapter/index.mjs

Export `createRealtimeAdapter`:

```javascript
import { AppSyncWebSocketClient }
  from './websocket.mjs';
import { RealtimeChannel } from './channel.mjs';

export function createRealtimeAdapter({ httpUrl, wsUrl }) {
  const wsClient = new AppSyncWebSocketClient({
    wsUrl, httpUrl
  });
  const channels = new Map();

  return {
    channel(name) {
      if (!channels.has(name)) {
        channels.set(name,
          new RealtimeChannel(name, wsClient, httpUrl));
      }
      return channels.get(name);
    },
    removeChannel(channel) {
      channel.unsubscribe();
      channels.delete(channel.name);
    },
  };
}
```

The adapter shares a single `AppSyncWebSocketClient`
across all channels. The WebSocket connects on the first
`subscribe()` call.

## Test Requirements

No additional unit tests beyond those in Task 01.

## Acceptance Criteria

- All `src/adapter/channel.test.mjs` tests for
  postgres_changes pass (tests 1, 2, 4-6, 8-14).
- All previously passing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
