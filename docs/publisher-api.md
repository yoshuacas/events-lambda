# Publisher API Reference

The publisher runs on Lambda (or any Node.js backend) and sends database change events to AppSync Events via IAM-signed HTTP POST.

## createEventPublisher(config)

Factory function that returns a publisher instance.

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apiEndpoint` | string | Yes | AppSync Events HTTP endpoint. Format: `https://{id}.appsync-api.{region}.amazonaws.com` |
| `region` | string | Yes | AWS region for SigV4 signing. Use `REGION_NAME` env var, not `AWS_REGION`. |

### Return Value

An object with two methods:

- `publishChange(params)` — build payload and publish a database change event
- `publish(channel, events)` — low-level publish to any channel

## publisher.publishChange(params)

Validates inputs, builds a Supabase-compatible payload, maps the table and event to an AppSync channel, signs the request, and sends it.

```javascript
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: { id: 'abc', text: 'hello', user_id: 'u-1' },
  oldRow: null,
});
```

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | string | No | `'public'` | Database schema name. |
| `table` | string | Yes | — | Table name. |
| `event` | string | Yes | — | Must be `'INSERT'`, `'UPDATE'`, or `'DELETE'`. |
| `newRow` | object | Conditional | — | The new row data. Required for INSERT and UPDATE. |
| `oldRow` | object | Conditional | — | The previous row data. Required for UPDATE and DELETE. |

### Behavior

- **Fire-and-forget.** Never throws. All errors are caught internally and logged to `console.error`.
- **Validation first.** Inputs are validated before any network call. Invalid inputs are logged and the method returns without publishing.
- **Payload construction.** Builds a Supabase-compatible payload with `commit_timestamp` set to the current time.
- **Channel mapping.** Table and schema names are sanitized for AppSync (underscores to dashes) and assembled into a channel path like `/db/public/messages/INSERT`.

### Payload Format

The published event matches the Supabase realtime payload format:

```json
{
  "schema": "public",
  "table": "messages",
  "commit_timestamp": "2026-04-12T18:00:00.000Z",
  "eventType": "INSERT",
  "new": { "id": "abc", "text": "hello", "user_id": "u-1" },
  "old": {},
  "errors": null
}
```

Note: `schema` and `table` in the payload retain the original values (e.g., `user_profiles` with underscores). Only the AppSync channel path uses the sanitized form (`user-profiles`).

### Validation Rules

| Rule | Error Message |
|------|--------------|
| `event` not one of INSERT, UPDATE, DELETE | `event must be INSERT, UPDATE, or DELETE` |
| `table` empty or missing | `table is required` |
| `schema` has invalid characters after sanitization | `schema contains characters not allowed in AppSync channel segments` |
| `schema` exceeds 50 characters after sanitization | `schema exceeds 50-character AppSync segment limit` |
| `table` has invalid characters after sanitization | `table contains characters not allowed in AppSync channel segments` |
| `table` exceeds 50 characters after sanitization | `table exceeds 50-character AppSync segment limit` |
| `newRow` missing for INSERT or UPDATE | `newRow is required for INSERT and UPDATE events` |
| `oldRow` missing for UPDATE or DELETE | `oldRow is required for UPDATE and DELETE events` |
| Serialized payload exceeds 240 KB | `event payload exceeds 240 KB limit` |

### Examples by Event Type

**INSERT:**
```javascript
await publisher.publishChange({
  table: 'messages',
  event: 'INSERT',
  newRow: { id: '1', text: 'hello', user_id: 'u-1' },
});
// Channel: /db/public/messages/INSERT
// Payload: { new: {id:'1',...}, old: {}, eventType: 'INSERT', ... }
```

**UPDATE:**
```javascript
await publisher.publishChange({
  table: 'messages',
  event: 'UPDATE',
  newRow: { id: '1', text: 'updated', user_id: 'u-1' },
  oldRow: { id: '1', text: 'hello', user_id: 'u-1' },
});
// Channel: /db/public/messages/UPDATE
// Payload: { new: {text:'updated',...}, old: {text:'hello',...}, eventType: 'UPDATE', ... }
```

**DELETE:**
```javascript
await publisher.publishChange({
  table: 'messages',
  event: 'DELETE',
  oldRow: { id: '1', text: 'updated', user_id: 'u-1' },
});
// Channel: /db/public/messages/DELETE
// Payload: { new: {}, old: {id:'1',...}, eventType: 'DELETE', ... }
```

## publisher.publish(channel, events)

Low-level method that publishes raw events to any AppSync channel. Most callers should use `publishChange` instead.

```javascript
await publisher.publish('/db/public/messages/INSERT', [
  { schema: 'public', table: 'messages', eventType: 'INSERT', new: row, old: {}, errors: null }
]);
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `channel` | string | Full AppSync channel path (e.g., `/db/public/messages/INSERT`). |
| `events` | Array&lt;object&gt; | Array of event payloads. Each is stringified before sending. Max 5 per request. |

## AppSyncEventsClient

Internal HTTP client used by the publisher. Not typically used directly.

```javascript
import { AppSyncEventsClient } from 'events-lambda';
// Not exported from the package entry point — import from the file directly if needed:
// import { AppSyncEventsClient } from 'events-lambda/src/publisher/appsync-client.mjs';
```

### Constructor

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apiEndpoint` | string | Yes | AppSync Events HTTP endpoint. |
| `region` | string | Yes | AWS region. |
| `signer` | SignatureV4 | No | Custom SigV4 signer (for testing). |
| `fetch` | function | No | Custom fetch implementation (for testing). |

### publish(channel, events)

Signs the request with IAM SigV4 and sends it to the AppSync Events `/event` endpoint.

**HTTP request format:**
```
POST {apiEndpoint}/event
Content-Type: application/json

{
  "channel": "/db/public/messages/INSERT",
  "events": [
    "{\"schema\":\"public\",\"table\":\"messages\",...}"
  ]
}
```

Each event in the `events` array is a JSON string (stringified by the client). This is an AppSync Events protocol requirement.

## Channel Mapping

The publisher uses `pgChangesChannel()` from `shared/protocol.mjs` to map table + event to an AppSync channel:

```
pgChangesChannel('public', 'messages', 'INSERT')
  → '/db/public/messages/INSERT'

pgChangesChannel('public', 'user_profiles', 'UPDATE')
  → '/db/public/user-profiles/UPDATE'

pgChangesChannel('myschema', 'orders', 'DELETE')
  → '/db/myschema/orders/DELETE'
```

## Dependencies

```json
{
  "@aws-sdk/credential-provider-node": "^3.0.0",
  "@aws-crypto/sha256-js": "^5.0.0",
  "@smithy/signature-v4": "^3.0.0"
}
```

These are AWS SDK signing utilities. The publisher has no database, Cognito, or Cedar dependencies.
