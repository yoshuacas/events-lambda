# events-lambda

Supabase-compatible real-time events on AWS AppSync Events.

## Server-side (Lambda)

Publish database changes after successful writes:

```javascript
import { createEventPublisher } from 'events-lambda';

const publisher = createEventPublisher({
  apiEndpoint: process.env.APPSYNC_EVENTS_ENDPOINT,
  region: process.env.REGION_NAME,
});

// After a successful INSERT:
await publisher.publishChange({
  schema: 'public',
  table: 'messages',
  event: 'INSERT',
  newRow: row,
});
```

## Client-side (browser)

Use with `@supabase/supabase-js` — standard realtime code works:

```javascript
import { createClient } from '@supabase/supabase-js';
import { createRealtimeAdapter } from 'events-lambda/adapter';

const supabase = createClient(apiUrl, anonKey, {
  realtime: createRealtimeAdapter({
    httpUrl: config.realtimeHttpUrl,
    wsUrl: config.realtimeWsUrl,
  })
});

// Subscribe to database changes
supabase.channel('my-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('New:', payload.new)
  )
  .subscribe()

// Broadcast (client-to-client)
const channel = supabase.channel('room1')
channel.on('broadcast', { event: 'typing' }, (payload) => { ... })
channel.subscribe(() => {
  channel.send({ type: 'broadcast', event: 'typing', payload: { user: 'alice' } })
})
```

## How It Works

- Backend writes → pgrest-lambda publishes event → AppSync Events broadcasts to subscribers
- AppSync Events manages all WebSocket connections (no DynamoDB table, no cleanup code)
- Client adapter translates Supabase realtime API to AppSync Events protocol
- File bytes and database queries never touch the events path

## Infrastructure

Add to your SAM template:

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

## License

Apache License 2.0
