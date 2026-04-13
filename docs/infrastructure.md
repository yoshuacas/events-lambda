# Infrastructure Guide

Deploy the AppSync Events API that powers `events-lambda` real-time push notifications.

## Overview

The infrastructure consists of a single AppSync Events API with three channel namespaces. It is defined as a SAM template snippet in `infrastructure/realtime.yaml` that you merge into your main stack template.

**Resources created:**
- AppSync Events API with Cognito + IAM auth
- Three channel namespaces: `db`, `broadcast`, `presence`
- IAM managed policy for Lambda publish permission

**No additional infrastructure needed.** AppSync Events manages all WebSocket connections, subscriptions, and fan-out. No DynamoDB tables, no cleanup Lambdas, no API Gateway WebSocket APIs.

## Prerequisites

- An existing Cognito User Pool (for client authentication)
- A Lambda function that will publish events (pgrest-lambda or your own backend)
- SAM CLI for deployment

## Template

The full template is at [`infrastructure/realtime.yaml`](../infrastructure/realtime.yaml). Here is the essential structure:

### AppSync Events API

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
```

**Auth providers:**
- `AMAZON_COGNITO_USER_POOLS` — for client subscribe and broadcast publish
- `AWS_IAM` — for server-side publish from Lambda

**Default modes:**
- Connection: Cognito (clients connect with their JWT)
- Publish: IAM (only Lambda can publish by default)
- Subscribe: Cognito (authenticated users can subscribe)

### Channel Namespaces

```yaml
# /db/* — database change events
# Publish: IAM (Lambda only). Subscribe: Cognito.
DbChannelNamespace:
  Type: AWS::AppSync::ChannelNamespace
  Properties:
    ApiId: !GetAtt RealtimeApi.ApiId
    Name: db

# /broadcast/* — client-to-client messaging
# Publish: Cognito. Subscribe: Cognito.
BroadcastChannelNamespace:
  Type: AWS::AppSync::ChannelNamespace
  Properties:
    ApiId: !GetAtt RealtimeApi.ApiId
    Name: broadcast
    PublishAuthModes:
      - AuthType: AMAZON_COGNITO_USER_POOLS
    SubscribeAuthModes:
      - AuthType: AMAZON_COGNITO_USER_POOLS

# /presence/* — presence tracking
# Publish: Cognito. Subscribe: Cognito.
PresenceChannelNamespace:
  Type: AWS::AppSync::ChannelNamespace
  Properties:
    ApiId: !GetAtt RealtimeApi.ApiId
    Name: presence
    PublishAuthModes:
      - AuthType: AMAZON_COGNITO_USER_POOLS
    SubscribeAuthModes:
      - AuthType: AMAZON_COGNITO_USER_POOLS
```

The `db` namespace uses the API-level defaults (IAM publish, Cognito subscribe). The `broadcast` and `presence` namespaces override publish auth to allow Cognito (client-to-client communication without Lambda).

### IAM Policy

```yaml
RealtimePublishPolicy:
  Type: AWS::IAM::ManagedPolicy
  Properties:
    Description: Allows Lambda to publish events to the AppSync Events API
    PolicyDocument:
      Version: "2012-10-17"
      Statement:
        - Effect: Allow
          Action:
            - appsync:EventPublish
          Resource:
            - !Sub "arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${RealtimeApi.ApiId}/*"
```

Attach this policy to your Lambda execution role. It grants publish permission to all channels on the AppSync Events API.

### Outputs

```yaml
Outputs:
  RealtimeApiId:
    Description: AppSync Events API ID
    Value: !GetAtt RealtimeApi.ApiId

  RealtimeHttpEndpoint:
    Description: AppSync Events HTTP endpoint
    Value: !GetAtt RealtimeApi.Dns.Http

  RealtimeWsEndpoint:
    Description: AppSync Events WebSocket endpoint
    Value: !GetAtt RealtimeApi.Dns.Realtime
```

## Integrating with Your Stack

### Step 1: Merge the template

Copy the resources from `infrastructure/realtime.yaml` into your main SAM template, or use nested stacks:

```yaml
RealtimeStack:
  Type: AWS::Serverless::Application
  Properties:
    Location: ./infrastructure/realtime.yaml
    Parameters:
      ProjectName: !Ref ProjectName
      UserPool: !Ref UserPool
```

### Step 2: Add environment variables to your Lambda

```yaml
MyApiFunction:
  Type: AWS::Serverless::Function
  Properties:
    # ...
    Environment:
      Variables:
        APPSYNC_EVENTS_ENDPOINT: !GetAtt RealtimeApi.Dns.Http
        APPSYNC_EVENTS_REALTIME: !GetAtt RealtimeApi.Dns.Realtime
        REGION_NAME: !Ref AWS::Region
    Policies:
      - !Ref RealtimePublishPolicy
```

Use `REGION_NAME`, not `AWS_REGION`. The `AWS_REGION` variable is reserved by the Lambda runtime and cannot be overridden.

### Step 3: Pass endpoints to the client

The client needs the HTTP and WebSocket URLs. Add them to your app config:

```javascript
// From your deployment config or API response:
const config = {
  realtimeHttpUrl: 'example.appsync-api.us-east-1.amazonaws.com',
  realtimeWsUrl: 'wss://example.appsync-realtime-api.us-east-1.amazonaws.com',
};
```

## Auth Model

### Database Changes (`/db/*`)

| Direction | Auth | Who |
|-----------|------|-----|
| Publish | IAM SigV4 | Lambda execution role only |
| Subscribe | Cognito JWT | Authenticated users |

Clients cannot publish to `/db/*`. They write through the REST API (pgrest-lambda), which publishes the event server-side.

### Broadcast (`/broadcast/*`)

| Direction | Auth | Who |
|-----------|------|-----|
| Publish | Cognito JWT | Authenticated clients |
| Subscribe | Cognito JWT | Authenticated clients |

Client-to-client communication. No Lambda involved. Clients publish directly over the WebSocket connection.

### Presence (`/presence/*`)

| Direction | Auth | Who |
|-----------|------|-----|
| Publish | Cognito JWT | Authenticated clients |
| Subscribe | Cognito JWT | Authenticated clients |

Same as broadcast. Used for presence tracking (Phase 3).

## Channel-Level Authorization

AppSync Events supports Cedar policies for fine-grained channel authorization. Use these to control which users can subscribe to which channels.

Example: Only allow authenticated users to subscribe to channels matching their authorized tables:

```cedar
permit(
  principal,
  action == AppSync::EventApi::Action::"Subscribe",
  resource
) when {
  principal.groups.contains("admin")
};
```

Cedar policy configuration is out of scope for this library but documented in the [AppSync Events documentation](https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html).

## Deployment

```bash
# Build and deploy
sam build
sam deploy --guided

# Or deploy with parameters
sam deploy \
  --parameter-overrides \
    ProjectName=myapp \
    UserPool=us-east-1_xxxxx
```

After deployment, the stack outputs provide the endpoint URLs:

```bash
# Get the outputs
aws cloudformation describe-stacks \
  --stack-name myapp \
  --query 'Stacks[0].Outputs'
```

## Endpoint URL Formats

| Endpoint | Format |
|----------|--------|
| HTTP (publisher) | `https://{id}.appsync-api.{region}.amazonaws.com` |
| WebSocket (adapter) | `wss://{id}.appsync-realtime-api.{region}.amazonaws.com` |

The HTTP endpoint is used by the publisher for SigV4-signed POST requests and by the adapter in the auth header (as the `host` field). The WebSocket endpoint is used by the adapter for the realtime connection.

## Cost

| Component | Pricing |
|-----------|---------|
| Connection minutes | $0.08 per million minutes |
| Messages (publish + deliver) | $1.00 per million messages |
| API operations | Free (included in connection/message pricing) |

Compare with API Gateway WebSocket: $0.25/M connection minutes, $1.00/M messages, plus DynamoDB costs for connection management.

## Limits

| Limit | Value |
|-------|-------|
| Max connections per API | 1,000,000 |
| Max subscriptions per connection | 100 |
| Outbound message throughput | 1,000,000 messages/second |
| Max event payload | 240 KB |
| Max events per publish request | 5 |
| Max connection duration | 24 hours |
| Keepalive interval | 60 seconds |
| Channel segment length | 50 characters |
| Channel segment count | 1-5 |

Source: [AWS AppSync Events quotas](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-quotas.html).
