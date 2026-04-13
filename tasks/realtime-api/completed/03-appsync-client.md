# Task 03: AppSync Events Client

Agent: implementer
Design: docs/design/realtime-api.md

## Objective

Implement the low-level AppSync Events HTTP client that
signs requests with SigV4 and sends events via POST.

## Target Tests

From `src/publisher/appsync-client.test.mjs`:
- publish sends POST to /event endpoint
- publish sends correct Content-Type header
- request body contains channel and events array
- events in the array are stringified JSON
- SigV4 signature is applied
- HTTP errors are caught and logged, not thrown
- fetch rejection is caught and logged, not thrown

## Implementation

### src/publisher/appsync-client.mjs

Create the `AppSyncEventsClient` class:

```javascript
import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from
  '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';

export class AppSyncEventsClient {
  constructor({ apiEndpoint, region }) {
    this.endpoint = apiEndpoint;
    this.signer = new SignatureV4({
      service: 'appsync',
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  async publish(channel, events) {
    // 1. Stringify each event
    // 2. Build body: { channel, events: [...strings] }
    // 3. Sign request with SigV4
    // 4. Send via fetch to {endpoint}/event
    // 5. Check response, log errors, never throw
  }
}
```

Key behaviors:
- The `publish` method stringifies each event object in
  the `events` array (`JSON.stringify(event)`) before
  placing it in the request body. AppSync Events requires
  events as JSON strings within the array.
- Content-Type: `application/json`.
- The full URL is `{apiEndpoint}/event`.
- SigV4 signing uses service name `appsync`.
- All errors (HTTP non-2xx, fetch rejection) are caught
  and logged via `console.error`. The method never throws.

Dependency injection: accept an optional `signer` in the
constructor for testing. If not provided, create the
default `SignatureV4` signer. Similarly, accept an optional
`fetchFn` for testing (defaults to global `fetch`).

## Test Requirements

No additional unit tests beyond those in Task 01.

## Acceptance Criteria

- All `src/publisher/appsync-client.test.mjs` tests pass.
- No other test files are broken.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true
  positives before marking the task complete.
