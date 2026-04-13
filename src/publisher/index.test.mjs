import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createEventPublisher } from './index.mjs';

describe('createEventPublisher / publishChange', () => {
  let publisher;
  let mockClient;
  let consoleErrorMock;

  beforeEach(() => {
    mockClient = {
      publish: mock.fn(() => Promise.resolve()),
    };

    publisher = createEventPublisher({
      apiEndpoint: 'https://example.com',
      region: 'us-east-1',
      _client: mockClient,
    });

    consoleErrorMock = mock.method(console, 'error', () => {});
  });

  it('publishChange with valid INSERT builds correct payload', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'INSERT',
      newRow: { id: '1' },
      oldRow: null,
    });

    assert.equal(mockClient.publish.mock.calls.length, 1);
    const [channel, events] = mockClient.publish.mock.calls[0].arguments;
    assert.equal(channel, '/db/public/messages/INSERT');
    const payload = events[0];
    assert.equal(payload.eventType, 'INSERT');
    assert.deepEqual(payload.new, { id: '1' });
    assert.deepEqual(payload.old, {});
    assert.equal(payload.errors, null);
  });

  it('publishChange with valid UPDATE includes old and new', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'UPDATE',
      newRow: { id: '1', text: 'new' },
      oldRow: { id: '1', text: 'old' },
    });

    const [, events] = mockClient.publish.mock.calls[0].arguments;
    const payload = events[0];
    assert.deepEqual(payload.new, { id: '1', text: 'new' });
    assert.deepEqual(payload.old, { id: '1', text: 'old' });
  });

  it('publishChange with valid DELETE has empty new', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'DELETE',
      newRow: null,
      oldRow: { id: '1' },
    });

    const [, events] = mockClient.publish.mock.calls[0].arguments;
    const payload = events[0];
    assert.deepEqual(payload.new, {});
    assert.deepEqual(payload.old, { id: '1' });
  });

  it('publishChange includes commit_timestamp as ISO 8601', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'INSERT',
      newRow: { id: '1' },
      oldRow: null,
    });

    const [, events] = mockClient.publish.mock.calls[0].arguments;
    const payload = events[0];
    assert.match(
      payload.commit_timestamp,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
  });

  it('publishChange preserves original table name in payload', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'user_profiles',
      event: 'INSERT',
      newRow: { id: '1' },
      oldRow: null,
    });

    const [channel, events] = mockClient.publish.mock.calls[0].arguments;
    const payload = events[0];
    assert.equal(payload.table, 'user_profiles');
    assert.equal(channel, '/db/public/user-profiles/INSERT');
  });

  it('publishChange rejects missing table', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: '',
      event: 'INSERT',
      newRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) => typeof arg === 'string' && arg.includes('table is required')
      )
    );
    assert.ok(errorLogged, 'expected "table is required" error to be logged');
  });

  it('publishChange rejects invalid event type *', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: '*',
      newRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('event must be INSERT, UPDATE, or DELETE')
      )
    );
    assert.ok(
      errorLogged,
      'expected "event must be INSERT, UPDATE, or DELETE" error to be logged'
    );
  });

  it('publishChange rejects event type SELECT', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'SELECT',
      newRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('event must be INSERT, UPDATE, or DELETE')
      )
    );
    assert.ok(
      errorLogged,
      'expected "event must be INSERT, UPDATE, or DELETE" error to be logged'
    );
  });

  it('publishChange rejects missing newRow for INSERT', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'INSERT',
      newRow: null,
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('newRow is required for INSERT and UPDATE events')
      )
    );
    assert.ok(
      errorLogged,
      'expected "newRow is required for INSERT and UPDATE events" error to be logged'
    );
  });

  it('publishChange rejects missing newRow for UPDATE', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'UPDATE',
      newRow: null,
      oldRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('newRow is required for INSERT and UPDATE events')
      )
    );
    assert.ok(
      errorLogged,
      'expected "newRow is required for INSERT and UPDATE events" error to be logged'
    );
  });

  it('publishChange rejects missing oldRow for UPDATE', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'UPDATE',
      newRow: { id: '1' },
      oldRow: null,
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('oldRow is required for UPDATE and DELETE events')
      )
    );
    assert.ok(
      errorLogged,
      'expected "oldRow is required for UPDATE and DELETE events" error to be logged'
    );
  });

  it('publishChange rejects missing oldRow for DELETE', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'DELETE',
      oldRow: null,
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('oldRow is required for UPDATE and DELETE events')
      )
    );
    assert.ok(
      errorLogged,
      'expected "oldRow is required for UPDATE and DELETE events" error to be logged'
    );
  });

  it('publishChange rejects schema with invalid characters', async () => {
    await publisher.publishChange({
      schema: 'my.schema',
      table: 'messages',
      event: 'INSERT',
      newRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes(
            'contains characters not allowed in AppSync channel segments'
          )
      )
    );
    assert.ok(
      errorLogged,
      'expected channel segment validation error to be logged'
    );
  });

  it('publishChange rejects table exceeding 50 characters', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'a'.repeat(51),
      event: 'INSERT',
      newRow: { id: '1' },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('exceeds 50-character AppSync segment limit')
      )
    );
    assert.ok(
      errorLogged,
      'expected segment length validation error to be logged'
    );
  });

  it('publishChange rejects payload exceeding 240 KB', async () => {
    await publisher.publishChange({
      schema: 'public',
      table: 'messages',
      event: 'INSERT',
      newRow: { data: 'x'.repeat(250000) },
    });

    assert.equal(mockClient.publish.mock.calls.length, 0);
    const errorLogged = consoleErrorMock.mock.calls.some((call) =>
      call.arguments.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('event payload exceeds 240 KB limit')
      )
    );
    assert.ok(
      errorLogged,
      'expected "event payload exceeds 240 KB limit" error to be logged'
    );
  });

  it('publishChange catches client errors and does not throw', async () => {
    mockClient.publish.mock.mockImplementation(() => {
      throw new Error('client exploded');
    });

    await assert.doesNotReject(() =>
      publisher.publishChange({
        schema: 'public',
        table: 'messages',
        event: 'INSERT',
        newRow: { id: '1' },
      })
    );
  });

  it('publishChange defaults schema to public', async () => {
    await publisher.publishChange({
      table: 'messages',
      event: 'INSERT',
      newRow: { id: '1' },
    });

    const [channel] = mockClient.publish.mock.calls[0].arguments;
    assert.equal(channel, '/db/public/messages/INSERT');
  });
});
