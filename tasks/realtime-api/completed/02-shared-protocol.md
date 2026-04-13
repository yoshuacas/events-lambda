# Task 02: Shared Protocol

Agent: implementer
Design: docs/design/realtime-api.md

## Objective

Implement the shared channel naming functions and error
constants used by both publisher and adapter.

## Target Tests

From `src/shared/protocol.test.mjs`:
- sanitizeSegment maps underscores to dashes
- sanitizeSegment accepts alphanumeric and dash
- sanitizeSegment rejects dots
- sanitizeSegment rejects other special characters
- sanitizeSegment rejects segments exceeding 50 characters
- sanitizeSegment accepts exactly 50 characters
- pgChangesChannel builds correct path
- pgChangesChannel maps underscores in table name
- pgChangesChannel supports wildcard event
- broadcastChannel builds correct path
- broadcastChannel maps underscores in channel name
- presenceChannel builds correct path

## Implementation

### src/shared/protocol.mjs

Create the following exported functions:

**`sanitizeSegment(name)`** — Replaces underscores with
dashes. Validates the result matches `[A-Za-z0-9-]+` and
is at most 50 characters. Throws descriptive errors on
failure. This is the single enforcement point for AppSync
channel segment naming rules.

```javascript
export function sanitizeSegment(name) {
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
```

**`pgChangesChannel(schema, table, event)`** — Returns
`/db/{sanitized-schema}/{sanitized-table}/{event}`. The
event segment is not sanitized (it is one of INSERT,
UPDATE, DELETE, or * for subscription wildcards).

**`broadcastChannel(channelName, eventName)`** — Returns
`/broadcast/{sanitized-channel}/{sanitized-event}`.

**`presenceChannel(channelName)`** — Returns
`/presence/{sanitized-channel}`.

### src/shared/errors.mjs

Create error message constants:

```javascript
export const ERRORS = {
  INVALID_EVENT: 'event must be INSERT, UPDATE, or DELETE',
  TABLE_REQUIRED: 'table is required',
  SCHEMA_INVALID_CHARS: 'schema contains characters not allowed in AppSync channel segments',
  SCHEMA_TOO_LONG: 'schema exceeds 50-character AppSync segment limit',
  TABLE_INVALID_CHARS: 'table contains characters not allowed in AppSync channel segments',
  TABLE_TOO_LONG: 'table exceeds 50-character AppSync segment limit',
  NEW_ROW_REQUIRED: 'newRow is required for INSERT and UPDATE events',
  OLD_ROW_REQUIRED: 'oldRow is required for UPDATE and DELETE events',
  PAYLOAD_TOO_LARGE: 'event payload exceeds 240 KB limit',
  BROADCAST_EVENT_INVALID: 'broadcast event name must match [A-Za-z0-9-]+ and be at most 50 characters',
  CHANNEL_NAME_INVALID: 'channel name must match [A-Za-z0-9-]+ and be at most 50 characters',
  BROADCAST_PAYLOAD_TOO_LARGE: 'payload exceeds 240 KB limit',
};

export const VALID_EVENTS = ['INSERT', 'UPDATE', 'DELETE'];
export const MAX_SEGMENT_LENGTH = 50;
export const MAX_PAYLOAD_BYTES = 240 * 1024;
```

## Test Requirements

No additional unit tests beyond those in Task 01. The
protocol.test.mjs tests cover all behaviors.

## Acceptance Criteria

- All `src/shared/protocol.test.mjs` tests pass.
- `src/shared/errors.mjs` exports all error constants.
- No other test files are broken by these changes.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
