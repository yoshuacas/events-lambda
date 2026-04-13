# Task 07: Broadcast

Agent: implementer
Design: docs/design/realtime-api.md
Depends on: Task 05, Task 06

## Objective

Implement client-to-client broadcast: sending messages via
WebSocket publish and receiving them via subscription
callbacks.

## Target Tests

From `src/adapter/channel.test.mjs`:
- on broadcast registers subscription to correct channel
- send broadcast publishes to correct channel
- broadcast event name with invalid characters is rejected
- broadcast event name exceeding 50 characters is rejected
- broadcast channel name with invalid characters is rejected
- broadcast send rejects payload exceeding 240 KB
- broadcast channel name with underscores maps to dashes

## Implementation

### src/adapter/broadcast.mjs

Create broadcast helpers:

```javascript
// Format a broadcast payload for sending via WebSocket
export function formatBroadcastEvent(eventName, payload) {
  return {
    event: eventName,
    payload,
    type: 'broadcast',
  };
}

// Parse an incoming broadcast event for delivery to callback
export function parseBroadcastEvent(rawEvent) {
  // rawEvent is already parsed from the data message.
  // Return as-is — the format matches what the callback
  // expects: { event, payload, type }
  return rawEvent;
}
```

### src/adapter/channel.mjs updates

Extend the `send()` method:

```javascript
async send({ type, event, payload }) {
  if (type === 'broadcast') {
    const channel = broadcastChannel(this.name, event);
    const formatted = formatBroadcastEvent(event, payload);
    await this.wsClient.publish(
      channel, [formatted], this.token
    );
  }
}
```

The broadcast `on()` registration is already handled in
Task 06 (the `on()` method maps `type: 'broadcast'` to
the correct channel). This task adds the `send()` path
and the broadcast payload formatting.

### Validation

The broadcast event name and channel name are validated
by `sanitizeSegment` (called inside `broadcastChannel`).
Error messages:
- Invalid event name: sanitizeSegment throws with
  `"contains characters not allowed in AppSync channel segments"`
- Invalid channel name: same error from sanitizeSegment
- Payload exceeding 240 KB: check serialized size of the
  full broadcast wrapper (event + payload + type fields)
  before sending. Log error and do not send.

### Broadcast auth

Broadcast publish and subscribe both use Cognito auth.
The adapter includes the JWT `authorization` object in
both subscribe and publish WebSocket messages. This is
already handled by the WebSocket client's `subscribe()`
and `publish()` methods from Task 05.

## Test Requirements

No additional unit tests beyond those in Task 01.

## Acceptance Criteria

- `src/adapter/channel.test.mjs` tests for broadcast
  pass (tests 3, 7, 15-19).
- All previously passing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
- If the broadcast `send()` test passes without verifying
  the exact channel path (`/broadcast/{channel}/{event}`),
  the test may be a false positive. Verify the channel
  string in the assertion.
