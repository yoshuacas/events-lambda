# Task 08: SAM Template

Agent: implementer
Design: docs/design/realtime-api.md

## Objective

Create the SAM template snippet for the AppSync Events API
with channel namespace configuration and IAM policy.

## Target Tests

No unit tests. This is an infrastructure-as-code task.

## Implementation

### infrastructure/realtime.yaml

Create a SAM template snippet defining:

**AppSync Events API (`RealtimeApi`):**
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

**Channel namespaces** with per-namespace auth overrides:
- `db`: default auth (IAM publish, Cognito subscribe)
- `broadcast`: Cognito publish and subscribe
- `presence`: Cognito publish and subscribe

```yaml
      ChannelNamespaces:
        - Name: db
        - Name: broadcast
          PublishAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
          SubscribeAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
        - Name: presence
          PublishAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
          SubscribeAuthModes:
            - AuthType: AMAZON_COGNITO_USER_POOLS
```

**IAM policy** for Lambda execution role:
```yaml
- Statement:
    - Effect: Allow
      Action:
        - appsync:EventPublish
      Resource:
        - !Sub "arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${RealtimeApi.ApiId}/*"
```

**Environment variables** for Lambda functions:
```yaml
Environment:
  Variables:
    APPSYNC_EVENTS_ENDPOINT: !GetAtt RealtimeApi.Dns.Http
    APPSYNC_EVENTS_REALTIME: !GetAtt RealtimeApi.Dns.Realtime
```

The template uses `APPSYNC_EVENTS_ENDPOINT` (not
`AWS_REGION` which is reserved by Lambda). The region is
read from `REGION_NAME` per project convention.

Include a comment header explaining the file's purpose
and how it integrates with the main stack template.

## Acceptance Criteria

- `infrastructure/realtime.yaml` exists and is valid YAML.
- Template defines the AppSync Events API with three
  channel namespaces (db, broadcast, presence).
- Auth model matches the design: IAM publish on /db/*,
  Cognito publish on /broadcast/* and /presence/*.
- IAM policy grants `appsync:EventPublish` to the Lambda
  role.
- Environment variables reference the API's HTTP and
  Realtime DNS endpoints.

## Conflict Criteria

- If `infrastructure/realtime.yaml` already exists with
  the correct configuration, verify it matches the design
  exactly before marking the task complete.
