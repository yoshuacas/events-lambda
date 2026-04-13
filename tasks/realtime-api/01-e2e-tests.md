# Task 01: End-to-End Tests

Agent: implementer
Design: docs/design/realtime-api.md

## Objective

Create all unit test files for the events-lambda library
covering shared protocol, server-side publisher, AppSync
client, client-side channel adapter, and WebSocket client.
All tests must compile and fail with clear messages
indicating the missing implementation.

## Test Files

Create the following test files using Node.js built-in
`node:test` and `node:assert`:

### src/shared/protocol.test.mjs

Tests for channel naming functions and segment sanitization.

1. **sanitizeSegment maps underscores to dashes**
   - Given: input `'user_profiles'`
   - When: `sanitizeSegment('user_profiles')` is called
   - Then: returns `'user-profiles'`

2. **sanitizeSegment accepts alphanumeric and dash**
   - Given: input `'my-channel'`
   - When: `sanitizeSegment('my-channel')` is called
   - Then: returns `'my-channel'` unchanged

3. **sanitizeSegment rejects dots**
   - Given: input `'hello.world'`
   - When: `sanitizeSegment('hello.world')` is called
   - Then: throws with message containing
     `"contains characters not allowed in AppSync channel segments"`

4. **sanitizeSegment rejects other special characters**
   - Given: input `'hello@world'`
   - When: `sanitizeSegment('hello@world')` is called
   - Then: throws with message containing
     `"contains characters not allowed in AppSync channel segments"`

5. **sanitizeSegment rejects segments exceeding 50 characters**
   - Given: input `'a'.repeat(51)`
   - When: `sanitizeSegment(input)` is called
   - Then: throws with message containing
     `"exceeds 50-character AppSync segment limit"`

6. **sanitizeSegment accepts exactly 50 characters**
   - Given: input `'a'.repeat(50)`
   - When: `sanitizeSegment(input)` is called
   - Then: returns the input unchanged (no error)

7. **pgChangesChannel builds correct path**
   - Given: schema `'public'`, table `'messages'`,
     event `'INSERT'`
   - When: `pgChangesChannel('public', 'messages', 'INSERT')`
   - Then: returns `'/db/public/messages/INSERT'`

8. **pgChangesChannel maps underscores in table name**
   - Given: schema `'public'`, table `'user_profiles'`,
     event `'INSERT'`
   - When: `pgChangesChannel('public', 'user_profiles', 'INSERT')`
   - Then: returns `'/db/public/user-profiles/INSERT'`

9. **pgChangesChannel supports wildcard event**
   - Given: schema `'public'`, table `'messages'`,
     event `'*'`
   - When: `pgChangesChannel('public', 'messages', '*')`
   - Then: returns `'/db/public/messages/*'`

10. **broadcastChannel builds correct path**
    - Given: channel `'room1'`, event `'cursor-move'`
    - When: `broadcastChannel('room1', 'cursor-move')`
    - Then: returns `'/broadcast/room1/cursor-move'`

11. **broadcastChannel maps underscores in channel name**
    - Given: channel `'my_room'`, event `'typing'`
    - When: `broadcastChannel('my_room', 'typing')`
    - Then: returns `'/broadcast/my-room/typing'`

12. **presenceChannel builds correct path**
    - Given: channel `'room1'`
    - When: `presenceChannel('room1')`
    - Then: returns `'/presence/room1'`

### src/publisher/appsync-client.test.mjs

Tests for the low-level AppSync Events HTTP client. Use a
mock HTTP layer (intercept `fetch` or inject a mock) to
verify request shape without network calls.

1. **publish sends POST to /event endpoint**
   - Given: client created with
     `apiEndpoint: 'https://example.com'`
   - When: `client.publish('/db/public/messages/INSERT', [payload])`
   - Then: fetch is called with URL
     `'https://example.com/event'` and method `'POST'`

2. **publish sends correct Content-Type header**
   - Given: a publish call
   - When: the request is sent
   - Then: `Content-Type` header is `'application/json'`

3. **request body contains channel and events array**
   - Given: channel `'/db/public/messages/INSERT'` and
     one payload object
   - When: publish is called
   - Then: request body is JSON with `channel` string and
     `events` array

4. **events in the array are stringified JSON**
   - Given: a payload object `{schema: 'public', ...}`
   - When: publish is called
   - Then: each element of the `events` array is a string,
     and `JSON.parse(events[0])` succeeds and matches the
     original payload

5. **SigV4 signature is applied**
   - Given: a mock signer
   - When: publish is called
   - Then: the signer's `sign` method is called with
     service `'appsync'`

6. **HTTP errors are caught and logged, not thrown**
   - Given: fetch returns a 500 response
   - When: publish is called
   - Then: no error is thrown; error is logged to console

7. **fetch rejection is caught and logged, not thrown**
   - Given: fetch rejects with a network error
   - When: publish is called
   - Then: no error is thrown; error is logged to console

### src/publisher/index.test.mjs

Tests for `createEventPublisher` and `publishChange`.
Mock the `AppSyncEventsClient` to isolate publisher logic.

1. **publishChange with valid INSERT builds correct payload**
   - Given: publisher with mocked client
   - When: `publishChange({schema: 'public', table: 'messages', event: 'INSERT', newRow: {id: '1'}, oldRow: null})`
   - Then: client.publish is called with channel
     `'/db/public/messages/INSERT'` and payload containing
     `eventType: 'INSERT'`, `new: {id: '1'}`, `old: {}`,
     `errors: null`

2. **publishChange with valid UPDATE includes old and new**
   - Given: publisher with mocked client
   - When: `publishChange({schema: 'public', table: 'messages', event: 'UPDATE', newRow: {id: '1', text: 'new'}, oldRow: {id: '1', text: 'old'}})`
   - Then: payload contains `new: {id: '1', text: 'new'}`
     and `old: {id: '1', text: 'old'}`

3. **publishChange with valid DELETE has empty new**
   - Given: publisher with mocked client
   - When: `publishChange({schema: 'public', table: 'messages', event: 'DELETE', newRow: null, oldRow: {id: '1'}})`
   - Then: payload contains `new: {}` and
     `old: {id: '1'}`

4. **publishChange includes commit_timestamp as ISO 8601**
   - Given: publisher with mocked client
   - When: publishChange is called with valid params
   - Then: payload `commit_timestamp` matches ISO 8601
     format (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)

5. **publishChange preserves original table name in payload**
   - Given: publisher with mocked client
   - When: `publishChange({table: 'user_profiles', ...})`
   - Then: payload `table` is `'user_profiles'` (not
     `'user-profiles'`), but channel uses
     `'/db/public/user-profiles/INSERT'`

6. **publishChange rejects missing table**
   - Given: publisher with mocked client
   - When: `publishChange({schema: 'public', table: '', event: 'INSERT', newRow: {id: '1'}})`
   - Then: client.publish is NOT called; error
     `"table is required"` is logged

7. **publishChange rejects invalid event type**
   - Given: publisher with mocked client
   - When: `publishChange({..., event: '*'})`
   - Then: client.publish is NOT called; error
     `"event must be INSERT, UPDATE, or DELETE"` is logged

8. **publishChange rejects event type SELECT**
   - Given: publisher with mocked client
   - When: `publishChange({..., event: 'SELECT'})`
   - Then: client.publish is NOT called; error
     `"event must be INSERT, UPDATE, or DELETE"` is logged

9. **publishChange rejects missing newRow for INSERT**
   - Given: publisher with mocked client
   - When: `publishChange({..., event: 'INSERT', newRow: null})`
   - Then: client.publish is NOT called; error
     `"newRow is required for INSERT and UPDATE events"`
     is logged

10. **publishChange rejects missing newRow for UPDATE**
    - Given: publisher with mocked client
    - When: `publishChange({..., event: 'UPDATE', newRow: null, oldRow: {id: '1'}})`
    - Then: client.publish is NOT called; error
      `"newRow is required for INSERT and UPDATE events"`
      is logged

11. **publishChange rejects missing oldRow for UPDATE**
    - Given: publisher with mocked client
    - When: `publishChange({..., event: 'UPDATE', newRow: {id: '1'}, oldRow: null})`
    - Then: client.publish is NOT called; error
      `"oldRow is required for UPDATE and DELETE events"`
      is logged

12. **publishChange rejects missing oldRow for DELETE**
    - Given: publisher with mocked client
    - When: `publishChange({..., event: 'DELETE', oldRow: null})`
    - Then: client.publish is NOT called; error
      `"oldRow is required for UPDATE and DELETE events"`
      is logged

13. **publishChange rejects schema with invalid characters**
    - Given: publisher with mocked client
    - When: `publishChange({schema: 'my.schema', ...})`
    - Then: client.publish is NOT called; error containing
      `"contains characters not allowed in AppSync channel segments"` is logged

14. **publishChange rejects table exceeding 50 characters**
    - Given: publisher with mocked client
    - When: `publishChange({table: 'a'.repeat(51), ...})`
    - Then: client.publish is NOT called; error containing
      `"exceeds 50-character AppSync segment limit"` is
      logged

15. **publishChange rejects payload exceeding 240 KB**
    - Given: publisher with mocked client
    - When: `publishChange({newRow: {data: 'x'.repeat(250000)}, ...})`
    - Then: client.publish is NOT called; error
      `"event payload exceeds 240 KB limit"` is logged

16. **publishChange catches client errors and does not throw**
    - Given: mocked client.publish that throws
    - When: publishChange is called
    - Then: no error propagates; error is logged

17. **publishChange defaults schema to public**
    - Given: publisher with mocked client
    - When: `publishChange({table: 'messages', event: 'INSERT', newRow: {id: '1'}})`
      (schema omitted)
    - Then: client.publish is called with channel
      `'/db/public/messages/INSERT'`

### src/adapter/websocket.test.mjs

Tests for `AppSyncWebSocketClient`. Use a mock WebSocket
(inject a factory or stub the `WebSocket` constructor).

1. **connect uses correct URL format**
   - Given: wsUrl `'wss://example.com'`
   - When: connect is called
   - Then: WebSocket is created with URL
     `'wss://example.com/event/realtime'`

2. **connect includes aws-appsync-event-ws subprotocol**
   - Given: a connect call
   - When: WebSocket is created
   - Then: subprotocols include `'aws-appsync-event-ws'`

3. **connect includes base64url-encoded auth subprotocol**
   - Given: httpUrl `'example.com'` and token `'my-jwt'`
   - When: connect is called
   - Then: subprotocols include a string starting with
     `'header-'` followed by base64url-encoded JSON
     containing `host` and `Authorization`

4. **connection_init is sent after WebSocket opens**
   - Given: mock WebSocket
   - When: the `open` event fires
   - Then: `{"type":"connection_init"}` is sent

5. **connection_ack is handled and timeout stored**
   - Given: mock WebSocket
   - When: server sends
     `{"type":"connection_ack","connectionTimeoutMs":300000}`
   - Then: client stores `connectionTimeoutMs` as 300000

6. **ka messages reset keepalive timer**
   - Given: connected client with keepalive tracking
   - When: server sends `{"type":"ka"}`
   - Then: keepalive timer is reset (verify timer was
     refreshed, not expired)

7. **subscribe sends correct message format**
   - Given: connected client
   - When: `subscribe('/db/public/messages/INSERT', token)`
   - Then: WebSocket sends JSON with `type: 'subscribe'`,
     a unique `id`, `channel`, and `authorization` object

8. **subscribe_success resolves the subscribe promise**
   - Given: a pending subscribe call
   - When: server sends `{"type":"subscribe_success","id":"sub-1"}`
   - Then: the subscribe promise resolves

9. **subscribe_error rejects the subscribe promise**
   - Given: a pending subscribe call
   - When: server sends `{"type":"subscribe_error","id":"sub-1"}`
   - Then: the subscribe promise rejects

10. **data messages are routed to subscription callbacks**
    - Given: subscription `sub-1` with callback `cb`
    - When: server sends
      `{"type":"data","id":"sub-1","event":["{\"eventType\":\"INSERT\"}"]}`
    - Then: `cb` is called with parsed event
      `{eventType: 'INSERT'}`

11. **data messages with multiple events invoke callback
    per event**
    - Given: subscription with callback `cb`
    - When: server sends data with
      `event: ['"{...}"', '"{...}"']` (two stringified
      events)
    - Then: `cb` is called twice, once per parsed event

12. **wildcard subscription extracts eventType from payload**
    - Given: subscription to `/db/public/messages/*` with
      callback `cb`
    - When: server sends data with event containing
      `eventType: 'INSERT'`
    - Then: `cb` receives the event with
      `eventType: 'INSERT'` (extracted from payload, not
      channel name)
    - Risk: a test that only checks the callback was
      invoked could pass even if the adapter routes by
      subscription ID alone and ignores eventType
      extraction. Verify the callback receives the correct
      eventType value in the parsed payload.

13. **publish sends correct message format (broadcast)**
    - Given: connected client
    - When: `publish('/broadcast/room1/typing', events, token)`
    - Then: WebSocket sends JSON with `type: 'publish'`,
      `channel`, `events` array of stringified JSON, and
      `authorization`

14. **publish_success resolves the publish promise**
    - Given: a pending publish call
    - When: server sends `{"type":"publish_success","id":"op-1"}`
    - Then: the publish promise resolves

15. **unsubscribe sends correct message**
    - Given: active subscription `sub-1`
    - When: `unsubscribe('sub-1')` is called
    - Then: WebSocket sends `{"type":"unsubscribe","id":"sub-1"}`

16. **unsubscribe_success cleans up subscription state**
    - Given: active subscription `sub-1`
    - When: server sends
      `{"type":"unsubscribe_success","id":"sub-1"}`
    - Then: subscription is removed from internal map

17. **multiple subscriptions share single WebSocket**
    - Given: two subscribe calls
    - When: both complete
    - Then: only one WebSocket instance was created

18. **connection-level error triggers error handler**
    - Given: connected client with error handler
    - When: server sends `{"type":"error"}`
    - Then: error handler is invoked

### src/adapter/channel.test.mjs

Tests for `RealtimeChannel` and `createRealtimeAdapter`.
Mock the `AppSyncWebSocketClient`.

1. **on postgres_changes registers subscription to correct
   channel**
   - Given: channel created via adapter
   - When: `channel.on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'messages'}, cb)`
   - Then: internal listener targets
     `/db/public/messages/INSERT`

2. **on postgres_changes with wildcard event registers
   wildcard channel**
   - Given: channel created via adapter
   - When: `channel.on('postgres_changes', {event: '*', schema: 'public', table: 'messages'}, cb)`
   - Then: internal listener targets
     `/db/public/messages/*`

3. **on broadcast registers subscription to correct channel**
   - Given: channel named `'room1'` created via adapter
   - When: `channel.on('broadcast', {event: 'cursor-move'}, cb)`
   - Then: internal listener targets
     `/broadcast/room1/cursor-move`

4. **subscribe opens WebSocket and sends subscribe messages**
   - Given: channel with two `on()` listeners
   - When: `channel.subscribe()` is called
   - Then: WebSocket client subscribe is called twice with
     correct channels

5. **subscribe callback receives SUBSCRIBED on success**
   - Given: channel with one listener
   - When: `channel.subscribe(statusCb)` and all
     subscribe_success messages arrive
   - Then: `statusCb` is called with `'SUBSCRIBED'`

6. **subscribe callback receives CHANNEL_ERROR on failure**
   - Given: channel with one listener
   - When: `channel.subscribe(statusCb)` and
     subscribe_error arrives
   - Then: `statusCb` is called with `'CHANNEL_ERROR'`

7. **send broadcast publishes to correct channel**
   - Given: subscribed channel named `'room1'`
   - When: `channel.send({type: 'broadcast', event: 'cursor-move', payload: {x: 1}})`
   - Then: WebSocket client publish is called with channel
     `/broadcast/room1/cursor-move` and payload wrapped in
     broadcast format
   - Risk: a test that only checks a publish message was
     sent without verifying the channel path could pass
     even if the channel mapping is wrong. Verify the
     exact channel string.

8. **unsubscribe sends unsubscribe for all subscriptions**
   - Given: subscribed channel with two listeners
   - When: `channel.unsubscribe()` is called
   - Then: WebSocket client unsubscribe is called for each
     subscription ID

9. **subscribe is idempotent**
   - Given: an already-subscribed channel
   - When: `channel.subscribe()` is called again
   - Then: no duplicate subscribe messages are sent

10. **incoming data is routed to correct callback**
    - Given: channel with two listeners on different tables
      (messages INSERT and users INSERT)
    - When: a data event arrives for the messages
      subscription
    - Then: only the messages callback fires, not the
      users callback
    - Risk: a test with only one subscription cannot
      distinguish between "routed correctly" and "delivered
      to all callbacks". This test uses two subscriptions
      where only one should fire.

11. **multiple on() listeners produce separate subscriptions**
    - Given: channel with three `on()` calls
    - When: `subscribe()` is called
    - Then: three separate subscribe messages are sent,
      each with a distinct subscription ID

12. **on postgres_changes with table containing underscores**
    - Given: channel created via adapter
    - When: `channel.on('postgres_changes', {event: 'INSERT', schema: 'public', table: 'user_profiles'}, cb)`
    - Then: internal listener targets
      `/db/public/user-profiles/INSERT`

13. **createRealtimeAdapter returns object with channel method**
    - Given: adapter created with valid config
    - When: `adapter.channel('test')` is called
    - Then: returns a `RealtimeChannel` instance with
      `on`, `subscribe`, `send`, `unsubscribe` methods

14. **removeChannel unsubscribes and cleans up**
    - Given: adapter with a subscribed channel
    - When: `adapter.removeChannel(channel)` is called
    - Then: channel is unsubscribed and removed from
      adapter's internal channel list

15. **broadcast event name with invalid characters is
    rejected**
    - Given: channel named `'room1'` created via adapter
    - When: `channel.on('broadcast', {event: 'bad.event'}, cb)`
      and then `channel.subscribe()`
    - Then: error containing `"contains characters not allowed in AppSync channel segments"` is thrown
      or channel status callback receives `'CHANNEL_ERROR'`

16. **broadcast event name exceeding 50 characters is
    rejected**
    - Given: channel named `'room1'` created via adapter
    - When: `channel.on('broadcast', {event: 'a'.repeat(51)}, cb)`
      and then `channel.subscribe()`
    - Then: error containing `"exceeds 50-character AppSync segment limit"` is thrown or channel status
      callback receives `'CHANNEL_ERROR'`

17. **broadcast channel name with invalid characters is
    rejected**
    - Given: channel named `'bad.room'` created via adapter
    - When: `channel.on('broadcast', {event: 'typing'}, cb)`
      and then `channel.subscribe()`
    - Then: error containing `"contains characters not allowed in AppSync channel segments"` is thrown
      or channel status callback receives `'CHANNEL_ERROR'`

18. **broadcast send rejects payload exceeding 240 KB**
    - Given: subscribed channel named `'room1'`
    - When: `channel.send({type: 'broadcast', event: 'big', payload: {data: 'x'.repeat(250000)}})`
    - Then: WebSocket publish is NOT called; error
      `"payload exceeds 240 KB limit"` is logged

19. **broadcast channel name with underscores maps to
    dashes**
    - Given: channel named `'my_room'` created via adapter
    - When: `channel.on('broadcast', {event: 'typing'}, cb)`
    - Then: internal listener targets
      `/broadcast/my-room/typing`

## Notes

- Use Node.js built-in `node:test` (`describe`, `it`,
  `beforeEach`, `afterEach`, `mock`) and `node:assert`.
- The project uses `"type": "module"` — all files are ESM
  (`.mjs` extension).
- Tests run via `node --test 'src/**/*.test.mjs'`.
- Mock external dependencies (fetch, WebSocket) rather
  than making network calls.
- For the WebSocket mock, create a minimal `MockWebSocket`
  class that emits `open`, `message`, `close`, `error`
  events and captures `send()` calls.
- Each test file should import from the module under test.
  Since the modules don't exist yet, imports will fail,
  causing all tests to fail — this is the expected state.

## Acceptance Criteria

- All five test files exist at the paths listed above.
- Running `node --test 'src/**/*.test.mjs'` exits with a
  non-zero code (all tests fail).
- Failures are due to missing modules (import errors), not
  syntax errors or test framework issues.
- Test names are descriptive and follow given/when/then
  intent.

## Conflict Criteria

- If any test that is expected to fail instead passes,
  first diagnose why by following the "Unexpected test
  results" steps: investigate the code path, verify the
  assertion targets the right behavior, and attempt to
  rewrite the test to isolate the intended path. Only
  escalate if you cannot construct a well-formed test that
  targets the desired behavior.
