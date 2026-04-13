# CLAUDE.md

## What Is events-lambda?

**events-lambda** is an open-source serverless real-time event library that provides Supabase Realtime-compatible push notifications backed by AWS AppSync Events. When data changes in the backend, subscribed clients receive updates instantly over WebSocket. `@supabase/supabase-js` channel methods (`on('postgres_changes', ...)`, broadcast, presence) work out of the box.

**Tagline:** Supabase-compatible real-time events on your own AWS account.

**Core value:** Developers use `@supabase/supabase-js` for real-time subscriptions the same way they would with Supabase, but events flow through AppSync Events (managed WebSocket infrastructure on AWS), publishes are triggered by the application layer (not WAL parsing), and authorization uses Cedar policies — all serverless, all on AWS.

## Companion Projects

This project is the real-time counterpart to:
- [pgrest-lambda](https://github.com/yoshuacas/pgrest-lambda) — PostgREST-compatible REST API + GoTrue-compatible auth
- [storage-lambda](https://github.com/yoshuacas/storage-lambda) — Supabase-compatible file storage on S3

Together they form a complete Supabase-equivalent backend on AWS, used by the [BOA](https://github.com/aws/boa) skill plugin.

**However, events-lambda is standalone.** It has its own identity, its own npm package, its own repo. Never reference BOA in code, docs, or comments. Reference companion projects only where the integration point is relevant.

## Architecture

```
Client A (writer)              pgrest-lambda            AppSync Events          Client B (subscriber)
    │                              │                         │                         │
    │ INSERT into messages         │                         │                         │
    │─────────────────────────────>│                         │                         │
    │                              │ 1. Execute in DSQL      │                         │
    │                              │ 2. Publish event ──────>│                         │
    │                              │    via events-lambda     │                         │
    │                              │                         │  broadcast ────────────>│
    │  201 Created                 │                         │  {event: INSERT,        │
    │<─────────────────────────────│                         │   table: messages,      │
    │                              │                         │   new: {...}}           │
```

## Two Components

### 1. Server-side publisher (this library)

An npm package that pgrest-lambda (or any backend) calls after a successful write to publish the change event to AppSync Events.

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After a successful write in pgrest-lambda:
await publisher.publish({
  channel: '/db/public.messages.INSERT',
  payload: { event: 'INSERT', schema: 'public', table: 'messages', new: row }
});
```

### 2. Client-side adapter

A thin adapter that translates `@supabase/supabase-js` realtime API calls into AppSync Events WebSocket subscriptions. Replaces `@supabase/realtime-js` under the hood.

```javascript
// Developer writes standard Supabase code:
supabase.channel('room1')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New message:', payload.new)
  )
  .subscribe()

// Under the hood: connects to AppSync Events WebSocket,
// subscribes to channel /db/public.messages.INSERT
```

## Target Repository Structure

```
events-lambda/
├── src/
│   ├── publisher/              # Server-side (runs on Lambda)
│   │   ├── index.mjs          # createEventPublisher() factory
│   │   ├── appsync-client.mjs # AppSync Events HTTP publish client
│   │   ├── channel-map.mjs    # Maps table+action → channel name
│   │   └── filter.mjs         # Skip publish if no subscribers (optional)
│   ├── adapter/                # Client-side (runs in browser/Node)
│   │   ├── index.mjs          # Entry point, patches supabase realtime
│   │   ├── channel.mjs        # Supabase channel API implementation
│   │   ├── websocket.mjs      # AppSync Events WebSocket client
│   │   ├── presence.mjs       # Presence state management
│   │   └── broadcast.mjs      # Client-to-client broadcast
│   └── shared/
│       ├── protocol.mjs       # Channel naming conventions, payload format
│       └── errors.mjs         # Error codes
├── infrastructure/
│   └── realtime.yaml          # SAM template snippet for AppSync Events API
├── migrations/
│   └── 001_realtime_tables.sql # Optional: presence state, message history
├── package.json
├── README.md
├── LICENSE
└── CLAUDE.md
```

## Critical Rules

1. **This project is standalone.** Never reference BOA or Harbor in code, docs, or comments.
2. **`@supabase/supabase-js` compatibility is a hard requirement.** The `channel()`, `on('postgres_changes', ...)`, broadcast, and presence APIs must behave identically to Supabase's client library.
3. **Application-layer event publishing.** Events are published by the backend after successful writes — not from database triggers, WAL, or LISTEN/NOTIFY. This is by design: it's explicit, efficient, and database-agnostic.
4. **Node.js 20.x for Lambda** — never Python.
5. **`REGION_NAME` env var, never `AWS_REGION`** — reserved by Lambda runtime.
6. **Fire-and-forget publishing.** The publish call should not block the write response. Use non-blocking HTTP POST to AppSync Events. If publish fails, the write still succeeds.
7. **AppSync Events manages all WebSocket complexity.** This library never manages connections, connection tables, or fan-out. AppSync handles that.
8. **Cedar authorization for channel subscriptions.** Subscribe permissions are enforced — not every user can subscribe to every table's changes.
9. **Channel naming convention is a contract.** Channel names follow a strict pattern: `/db/{schema}.{table}.{event}` for postgres_changes, `/broadcast/{channel}` for broadcast, `/presence/{channel}` for presence. This convention is shared between publisher and adapter.

## AppSync Events Integration

AppSync Events is declared in the SAM template alongside the rest of the stack:

```yaml
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
      ChannelNamespaces:
        - Name: db
        - Name: broadcast
        - Name: presence
```

**Publish auth: AWS_IAM** — only the Lambda execution role can publish. Clients cannot publish postgres_changes events directly (they write through the REST API, which triggers the publish).

**Subscribe auth: Cognito** — authenticated users subscribe using their JWT. Channel-level authorization via Cedar policies determines which tables/events each user can subscribe to.

**Broadcast exception:** For the `/broadcast/*` namespace, both publish and subscribe use Cognito auth, enabling client-to-client communication.

## Authorizer Contract

Reuses the same Lambda authorizer as pgrest-lambda:
```javascript
event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
event.requestContext.authorizer.userId   // user UUID or '' for anon
event.requestContext.authorizer.email    // user email or ''
```

For AppSync Events, Cognito tokens are validated directly by AppSync (no custom authorizer needed).

## Plan Execution with rring

This project uses [rring](https://github.com/yoshuacas/rring) for design-driven development. rring is installed at `/home/ec2-user/rring/target/debug/rring`. The agent runtime is **Claude Code**.

**Workflow:**
1. `rring start <feature-name> "<description>"` — create a feature prompt
2. `rring design <feature-name>` — generate a design document
3. `rring task <feature-name>` — break into implementation tasks
4. `rring work` — execute tasks via the implementer agent loop
5. `rring review <feature-name>` — code review

Use feature branches: one branch per feature. Finalize by squashing to a single commit on merge.

## Writing Standards

- No AI-sounding language, no buzzwords
- Active voice, concise, plain English
- Every data point needs a source
