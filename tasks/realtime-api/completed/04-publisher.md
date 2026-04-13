# Task 04: Publisher

Agent: implementer
Design: docs/design/realtime-api.md
Depends on: Task 02, Task 03

## Objective

Implement the `createEventPublisher` factory and
`publishChange` method that validates inputs, builds
Supabase-compatible payloads, and publishes via the
AppSync Events client.

## Target Tests

From `src/publisher/index.test.mjs`:
- publishChange with valid INSERT builds correct payload
- publishChange with valid UPDATE includes old and new
- publishChange with valid DELETE has empty new
- publishChange includes commit_timestamp as ISO 8601
- publishChange preserves original table name in payload
- publishChange rejects missing table
- publishChange rejects invalid event type
- publishChange rejects event type SELECT
- publishChange rejects missing newRow for INSERT
- publishChange rejects missing newRow for UPDATE
- publishChange rejects missing oldRow for UPDATE
- publishChange rejects missing oldRow for DELETE
- publishChange rejects schema with invalid characters
- publishChange rejects table exceeding 50 characters
- publishChange rejects payload exceeding 240 KB
- publishChange catches client errors and does not throw
- publishChange defaults schema to public

## Implementation

### src/publisher/index.mjs

Export `createEventPublisher(config)`:

```javascript
import { AppSyncEventsClient } from './appsync-client.mjs';
import { pgChangesChannel } from '../shared/protocol.mjs';
import { ERRORS, VALID_EVENTS, MAX_PAYLOAD_BYTES }
  from '../shared/errors.mjs';

export function createEventPublisher({ apiEndpoint, region }) {
  const client = new AppSyncEventsClient({
    apiEndpoint, region
  });
  return { publishChange, publish: client.publish.bind(client) };

  async function publishChange({
    schema = 'public', table, event, newRow, oldRow
  }) {
    try {
      // Validation (see rules below)
      // Build channel via pgChangesChannel()
      // Build Supabase-compatible payload
      // Check payload size
      // Call client.publish(channel, [payload])
    } catch (err) {
      console.error('events-lambda: publish failed', err);
    }
  }
}
```

Validation order:
1. `event` must be in `VALID_EVENTS` — error:
   `ERRORS.INVALID_EVENT`
2. `table` must be non-empty — error: `ERRORS.TABLE_REQUIRED`
3. `newRow` required for INSERT/UPDATE — error:
   `ERRORS.NEW_ROW_REQUIRED`
4. `oldRow` required for UPDATE/DELETE — error:
   `ERRORS.OLD_ROW_REQUIRED`
5. `pgChangesChannel()` validates schema and table
   segments (throws on invalid characters or length)
6. Serialized payload must be <= `MAX_PAYLOAD_BYTES` —
   error: `ERRORS.PAYLOAD_TOO_LARGE`

Payload construction:
```javascript
const payload = {
  schema,            // original value (e.g., 'user_profiles')
  table,             // original value
  commit_timestamp: new Date().toISOString(),
  eventType: event,  // 'INSERT', 'UPDATE', or 'DELETE'
  new: newRow || {},
  old: oldRow || {},
  errors: null,
};
```

The `schema` and `table` fields in the payload preserve
the original names (with underscores). Only the channel
path uses the sanitized form.

### src/publisher/channel-map.mjs

Re-export for convenience:
```javascript
export { pgChangesChannel } from '../shared/protocol.mjs';
```

## Test Requirements

No additional unit tests beyond those in Task 01.

## Acceptance Criteria

- All `src/publisher/index.test.mjs` tests pass.
- All previously passing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
