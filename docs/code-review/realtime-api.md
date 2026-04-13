# Code Review: realtime-api

## Correctness

### WebSocket constructor called without `new`

**File:** `src/adapter/websocket.mjs` (line 39)

The WebSocket implementation is invoked as a plain function:

```javascript
this.ws = this.WebSocketImpl(url, protocols);
```

The native `WebSocket` API and the `ws` npm package both
require construction with `new`. ESM modules run in strict
mode, so calling a class constructor without `new` throws
`TypeError: Class constructor WebSocket cannot be invoked
without 'new'`. This crashes on every `connect()` call in
production.

The test passes because the mock `wsFactory` is a plain
function (not a class), so it works when called without
`new`.

**Proposed test:**

> Given an AppSyncWebSocketClient constructed with the
> native WebSocket class (or a class-based mock)
> When connect() is called
> Then the WebSocket is instantiated without TypeError

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_connect_with_class_based_websocket`

---

### subscribe() resolves to undefined, breaking unsubscribe

**File:** `src/adapter/websocket.mjs` (line 89)

When `subscribe_success` is received, the pending operation
is resolved with no argument:

```javascript
case 'subscribe_success': {
  const op = this.pendingOps.get(msg.id);
  if (op) {
    this.pendingOps.delete(msg.id);
    op.resolve();  // resolves to undefined
  }
  break;
}
```

In `channel.mjs:49-54`, the return value is stored:

```javascript
const subId = await this._wsClient.subscribe(...);
this._subscriptionIds.push(subId);
```

Since `subId` is `undefined`, `_subscriptionIds` becomes
`[undefined, undefined, ...]`. When `unsubscribe()` later
iterates these, it calls
`this._wsClient.unsubscribe(undefined)`, which sends
`{"type": "unsubscribe", "id": null}` on the wire. The
server will reject this. Additionally, multiple calls to
`pendingOps.set(undefined, ...)` overwrite each other in
the Map, so only one unsubscribe promise would ever
resolve.

The fix: `op.resolve(msg.id)` in the `subscribe_success`
handler.

The channel.test.mjs mock masks this bug because it
returns a real ID from its subscribe mock:
`Promise.resolve(id)`.

**Proposed test:**

> Given a RealtimeChannel with two postgres_changes
> listeners wired to a real AppSyncWebSocketClient
> (not the mock)
> When subscribe() completes and then unsubscribe() is
> called
> Then the unsubscribe messages sent on the WebSocket
> contain the actual subscription UUIDs (not null/undefined)

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_subscribe_resolves_with_subscription_id`

---

### connect() promise never rejects on failure

**File:** `src/adapter/websocket.mjs` (line 28)

The `connect()` method captures `reject` in the Promise
constructor but never calls it. If the WebSocket `error`
event fires before `connection_ack` (e.g., network
unreachable, invalid URL), the error handler fires but
`_connectResolve` is never called and the promise hangs
forever. Callers like `channel.mjs:45` will await
indefinitely.

**Proposed test:**

> Given an AppSyncWebSocketClient
> When connect() is called and the WebSocket emits an
> error event before connection_ack
> Then the connect() promise rejects with an error

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_connect_rejects_on_websocket_error`

---

### connect() has no idempotency guard

**File:** `src/adapter/websocket.mjs` (line 27-56)

Every call to `connect()` creates a new WebSocket and
overwrites `this.ws`. If two channels call `subscribe()`
concurrently (which calls `connect()` internally), the
second `connect()` overwrites `_connectResolve`, so the
first caller's promise never resolves. Existing
subscriptions on the first WebSocket are abandoned.

The design states "Shares a single WebSocket across all
channels and subscriptions." There is no check for an
existing connection.

**Proposed test:**

> Given an AppSyncWebSocketClient that is already
> connected
> When connect() is called a second time
> Then the existing WebSocket is reused (no new WebSocket
> is created) and the second connect() resolves immediately

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_connect_idempotent_when_already_connected`

---

### Buffer.byteLength used in client-side adapter code

**File:** `src/adapter/channel.mjs` (line 69)

The `send()` method uses `Buffer.byteLength(serialized,
'utf8')` to check payload size. `Buffer` is a Node.js
global and does not exist in browser environments. The
adapter is documented as client-side code ("runs in
browser/Node"). This will throw `ReferenceError: Buffer is
not defined` when called from a browser.

The publisher (`src/publisher/index.mjs:42`) also uses
`Buffer.byteLength`, but that code runs on Lambda (Node.js)
so it's fine.

**Proposed test:**

> Given a RealtimeChannel running in an environment where
> `Buffer` is not defined (simulated by shadowing
> globalThis.Buffer)
> When send() is called with a broadcast message
> Then the payload size check does not throw a
> ReferenceError

**Test location:** `src/adapter/channel.test.mjs`
**Function:** `test_send_broadcast_without_buffer_global`

---

### send() silently drops oversized broadcast payloads

**File:** `src/adapter/channel.mjs` (lines 69-71)

When the serialized broadcast payload exceeds 240 KB,
`send()` returns `undefined` with no error, no log, and no
callback notification. The caller has no way to know the
message was dropped. The design specifies the error message
`"payload exceeds 240 KB limit"`.

**Proposed test:**

> Given a subscribed RealtimeChannel
> When send() is called with a broadcast payload exceeding
> 240 KB
> Then the method either throws an error or returns a
> result indicating the message was not sent (not silent
> undefined)

**Test location:** `src/adapter/channel.test.mjs`
**Function:** `test_send_broadcast_oversized_reports_error`

---

### removeChannel does not await unsubscribe()

**File:** `src/adapter/channel.mjs` (line 109)

`removeChannel` calls `channel.unsubscribe()` without
`await`. Since `unsubscribe()` is async (it sends WebSocket
messages and waits for responses), the unsubscriptions
fire-and-forget. If the caller does anything after
`removeChannel` that depends on the channel being fully
cleaned up (e.g., re-creating the same channel name), there
is a race condition.

**Proposed test:**

> Given a subscribed RealtimeChannel
> When removeChannel() is called and then a new channel
> with the same name is immediately created and subscribed
> Then the new channel subscribes successfully without
> interference from pending unsubscribe operations

**Test location:** `src/adapter/channel.test.mjs`
**Function:** `test_remove_channel_then_recreate_same_name`

---

### event parameter not sanitized in pgChangesChannel

**File:** `src/shared/protocol.mjs` (line 17)

The `event` argument is concatenated into the channel path
without passing through `sanitizeSegment`:

```javascript
return `/db/${sanitizeSegment(schema)}/` +
  `${sanitizeSegment(table)}/${event}`;
```

On the publisher side, this is safe because `publishChange`
validates `event` against `VALID_EVENTS` before calling
`pgChangesChannel`. On the adapter side, the `event` comes
from user-provided filter options and could contain
arbitrary strings. While the `*` wildcard is intentionally
valid for subscriptions, other values (e.g.,
`../../broadcast/secret`) would produce malformed channel
paths.

This is speculative -- AppSync would likely reject the
subscribe, but the channel path is still constructed
unguarded.

**Proposed test:**

> Given a RealtimeChannel
> When on('postgres_changes', { event: '../../attack' })
> is called followed by subscribe()
> Then either the on() call or subscribe() rejects with a
> validation error

**Test location:** `src/adapter/channel.test.mjs`
**Function:** `test_postgres_changes_rejects_invalid_event_string`

## Sustainability

### Error message constants not used by sanitizeSegment

**File:** `src/shared/protocol.mjs` (lines 3-11) vs
`src/shared/errors.mjs` (lines 2-8)

`sanitizeSegment` constructs error messages inline:

```javascript
throw new Error(
  `"${name}" contains characters not allowed...`
);
```

Meanwhile, `errors.mjs` defines specific constants like
`ERRORS.SCHEMA_INVALID_CHARS`, `ERRORS.TABLE_INVALID_CHARS`
with similar but not identical wording. This means:

1. The protocol module and errors module can drift out of
   sync.
2. Tests that match against error message text (e.g.,
   `assert.match(err.message, /contains characters/)`) are
   fragile -- they'd pass even if the wrong error constant
   was used.
3. The error messages from `sanitizeSegment` include the
   input name in the message, while the `ERRORS` constants
   do not, making the constants unsuitable as-is. Either
   the constants should accept parameters or
   `sanitizeSegment` should be the canonical source and
   the constants should be removed/updated.

**Proposed test (boundary exercise):**

> Given a publisher calling publishChange with
> schema='my.schema'
> When the error is caught and logged
> Then the logged message matches the ERRORS constant for
> schema validation (not just a substring)

**Test location:** `src/publisher/index.test.mjs`
**Function:** `test_schema_error_message_matches_constant`

---

### parseBroadcastEvent exported but never used

**File:** `src/adapter/broadcast.mjs` (line 11)

`parseBroadcastEvent` is defined and exported but never
imported anywhere in the codebase. It's an identity function
(`return rawEvent`). If broadcast receive parsing is needed
in the future, it should be wired into the data message
handler in `websocket.mjs`. Currently it's dead code.

---

### No connection lifecycle management

**File:** `src/adapter/websocket.mjs`

The WebSocket client has no `isConnected` state, no
`disconnect()` method, and no cleanup for the keepalive
timer. If the WebSocket closes unexpectedly:

- `this.ws` still points to the dead socket.
- `subscribe()` calls on a dead socket would fail silently
  or throw.
- The keepalive timer continues running in the background.
- `_startKeepaliveTimer` (line 196-200) has an empty
  callback body, documented as "Phase 5." Until Phase 5 is
  implemented, the timer fires, does nothing, and is never
  cleared on disconnect.

This will become a maintenance burden when reconnection is
added, since there is no clean state machine to build on.

## Idiomatic Usage

### WebSocket must be constructed with `new`

**File:** `src/adapter/websocket.mjs` (line 39)

Per both the browser WebSocket API (MDN) and the `ws` npm
package, WebSocket is a class and must be called with `new`:

```javascript
// Correct
this.ws = new this.WebSocketImpl(url, protocols);

// Current (incorrect)
this.ws = this.WebSocketImpl(url, protocols);
```

The AWS AppSync Events documentation examples also use
`new WebSocket(...)`.

---

### base64url encoding via Buffer is idiomatic for Node

**File:** `src/adapter/websocket.mjs` (lines 4-6)

The `base64urlEncode` function uses
`Buffer.from(str).toString('base64url')`, which is
Node.js-specific. The adapter is described as client-side
code. The idiomatic approach for cross-environment code is
to use `btoa()` with manual character replacement (as shown
in the AWS documentation):

```javascript
btoa(str)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
```

Or use the `TextEncoder` API which is available in both
Node.js and browsers.

---

### SigV4 signer version mismatch

**File:** `package.json` (line 28) vs
`src/publisher/appsync-client.mjs` (line 1)

`package.json` declares `"@smithy/signature-v4": "^3.0.0"`
(major version 3) as a direct dependency. However,
`@aws-sdk/core` (pulled in transitively by
`@aws-sdk/credential-provider-node`) ships its own
`@smithy/signature-v4` at version 5.x. The publisher
imports from the v3 package:

```javascript
import { SignatureV4 } from '@smithy/signature-v4';
```

This means two different versions of signature-v4 are in
`node_modules`. The v3 package uses `@smithy/types` v3
while the SDK uses v4, which can cause type mismatches at
runtime. The idiomatic approach is to use the same version
the AWS SDK uses, or import signing utilities from
`@aws-sdk/core` directly.

## Test Quality

### Missing: subscribe() return value integration test

The channel.test.mjs tests use a mock WebSocket client that
returns a real subscription ID from `subscribe()`. The real
`AppSyncWebSocketClient.subscribe()` resolves to
`undefined`. No test exercises the full
channel-to-websocket-client path where this bug would
surface.

**Proposed test:**

> Given a RealtimeChannel wired to a real
> AppSyncWebSocketClient (with mock WebSocket transport)
> When subscribe() completes successfully
> Then the channel's internal subscription IDs are valid
> UUIDs (not undefined)

**Test location:** `src/adapter/channel.test.mjs`
**Function:** `test_subscribe_stores_real_subscription_ids`

---

### Missing: publish_error handling test

**File:** `src/adapter/websocket.mjs` (lines 115-124)

The `publish_error` case is implemented but has no test
coverage. This means the rejection logic could be broken
without any test failing.

**Proposed test:**

> Given a connected AppSyncWebSocketClient with a pending
> publish operation
> When the server responds with publish_error
> Then the publish promise rejects with the error message

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_publish_error_rejects_promise`

---

### Missing: connect() failure path test

No test covers what happens when the WebSocket connection
fails (error event before connection_ack). The current
implementation hangs the promise forever.

**Proposed test:**

> Given an AppSyncWebSocketClient
> When connect() is called and the WebSocket emits an
> error event without ever sending connection_ack
> Then connect() rejects (or times out) rather than
> hanging

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_connect_failure_does_not_hang`

---

### Missing: empty string inputs to sanitizeSegment

No test covers `sanitizeSegment('')`. The current regex
(`/^[A-Za-z0-9-]+$/`) rejects empty strings (due to `+`),
but the error message says "contains characters not
allowed" which is misleading for an empty input.

**Proposed test:**

> Given an empty string
> When sanitizeSegment('') is called
> Then it throws an error indicating the segment is
> empty/invalid

**Test location:** `src/shared/protocol.test.mjs`
**Function:** `test_sanitize_segment_rejects_empty_string`

---

### Missing: publishChange() with no arguments

The function signature has `= {}` default, but calling
`publishChange()` with no arguments would hit the
`!VALID_EVENTS.includes(undefined)` path. There's no test
verifying this doesn't throw unexpectedly (the catch block
should handle it).

**Proposed test:**

> Given a publisher
> When publishChange() is called with no arguments
> Then it does not throw and logs an appropriate error

**Test location:** `src/publisher/index.test.mjs`
**Function:** `test_publish_change_no_arguments`

---

### Missing: unsubscribe error path

There is no `unsubscribe_error` handler in
`websocket.mjs` `_handleMessage`. If the server sends an
`unsubscribe_error` response, the pending operation promise
hangs forever. There is also no test for this.

**Proposed test:**

> Given a connected client with an active subscription
> When unsubscribe() is called and the server responds
> with unsubscribe_error
> Then the unsubscribe promise rejects with an error

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_unsubscribe_error_rejects_promise`

---

### Missing: concurrent connect() calls

No test verifies the behavior when `connect()` is called
multiple times concurrently (e.g., two channels subscribing
simultaneously). The current implementation would create
multiple WebSocket instances.

**Proposed test:**

> Given an AppSyncWebSocketClient
> When connect() is called twice concurrently
> Then only one WebSocket connection is created and both
> callers resolve

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_concurrent_connect_creates_single_socket`

---

### Weak assertion: ka keepalive timer test

**File:** `src/adapter/websocket.test.mjs` (line 181)

The test asserts `afterKa >= beforeKa` which is trivially
true since `Date.now()` is monotonic. A stronger assertion
would verify the keepalive timer was actually reset (e.g.,
by mocking setTimeout/clearTimeout and verifying
clearTimeout was called).

**Proposed test:**

> Given a connected client with an active keepalive timer
> When a ka message arrives
> Then the previous timer is cleared and a new timer is
> started

**Test location:** `src/adapter/websocket.test.mjs`
**Function:** `test_ka_resets_keepalive_timer_properly`

## Test Harness Gaps

### Integration test path: channel through real WebSocket client

**Needed by:** `test_subscribe_stores_real_subscription_ids`,
`test_subscribe_resolves_with_subscription_id`

**Description:** The channel tests use a mock WebSocket
client (`mockWsClient`) that bypasses the actual
`AppSyncWebSocketClient`. There is no test that wires a
`RealtimeChannel` to a real `AppSyncWebSocketClient` (with
a mock transport). This gap hides the subscribe-ID-is-
undefined bug. A helper function or fixture is needed that
creates a `RealtimeChannel` backed by a real
`AppSyncWebSocketClient` using the `MockWebSocket` class
from `websocket.test.mjs`. The `MockWebSocket` class
should be extracted to a shared test helper so both test
files can use it.

---

### Class-based WebSocket mock

**Needed by:** `test_connect_with_class_based_websocket`

**Description:** The current `MockWebSocket` is a plain
class but the `wsFactory` mock is a function that returns
instances. To test that `new this.WebSocketImpl()` works
correctly (after the fix), the test harness needs a mock
that can be called with `new` -- i.e., the factory should
be updated to use `new MockWebSocket(url, protocols)`
instead of returning a plain object.

---

### Timer mocking utilities

**Needed by:** `test_ka_resets_keepalive_timer_properly`,
`test_connect_failure_does_not_hang`

**Description:** Tests that verify timer behavior
(keepalive reset, connection timeout) need the ability to
mock `setTimeout` and `clearTimeout`. Node.js test runner
supports `mock.timers` (available since Node 20.4). The
test harness should use `mock.timers.enable()` for timer-
dependent tests rather than relying on `Date.now()`
comparisons.

---

### Browser environment simulation

**Needed by:** `test_send_broadcast_without_buffer_global`

**Description:** Tests that verify browser compatibility
need a way to simulate an environment without Node.js
globals like `Buffer`. A helper that temporarily removes
`globalThis.Buffer` (and restores it in cleanup) would
allow testing the adapter's behavior in browser-like
environments.

## Documentation

- No `.kiro/skills/` files exist in this repo; no updates
  needed.
- No `.kiro/steering/` files exist; no updates needed.
- No `AGENTS.md` exists; no updates needed.
- `CLAUDE.md` references the channel naming convention as
  `/db/{schema}.{table}.{event}` with dots in the
  "Channel naming convention is a contract" section (rule
  9). The implementation uses slashes instead of dots
  (e.g., `/db/public/messages/INSERT`). The design document
  explains this change, but `CLAUDE.md` rule 9 still shows
  the old dot-based convention and should be updated to
  match the implementation.
