import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { AppSyncEventsClient } from './appsync-client.mjs';

describe('AppSyncEventsClient', () => {
  let client;
  let fetchMock;
  let signerMock;

  beforeEach(() => {
    fetchMock = mock.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );

    signerMock = {
      sign: mock.fn((request) => Promise.resolve(request)),
    };

    client = new AppSyncEventsClient({
      apiEndpoint: 'https://example.com',
      signer: signerMock,
      fetch: fetchMock,
    });
  });

  it('publish sends POST to /event endpoint', async () => {
    await client.publish('/db/public/messages/INSERT', [{ id: '1' }]);

    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://example.com/event');
    assert.equal(options.method, 'POST');
  });

  it('publish sends correct Content-Type header', async () => {
    await client.publish('/db/public/messages/INSERT', [{ id: '1' }]);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
  });

  it('request body contains channel and events array', async () => {
    const payload = { schema: 'public', table: 'messages' };
    await client.publish('/db/public/messages/INSERT', [payload]);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.equal(body.channel, '/db/public/messages/INSERT');
    assert.ok(Array.isArray(body.events));
  });

  it('events in the array are stringified JSON', async () => {
    const payload = { schema: 'public', table: 'messages' };
    await client.publish('/db/public/messages/INSERT', [payload]);

    const [, options] = fetchMock.mock.calls[0].arguments;
    const body = JSON.parse(options.body);
    assert.equal(typeof body.events[0], 'string');
    const parsed = JSON.parse(body.events[0]);
    assert.deepEqual(parsed, payload);
  });

  it('SigV4 signature is applied', async () => {
    await client.publish('/db/public/messages/INSERT', [{ id: '1' }]);

    assert.equal(signerMock.sign.mock.calls.length, 1);
    const signArgs = signerMock.sign.mock.calls[0].arguments;
    // The signer should be called with a request that includes
    // service 'appsync' in the signing config
    assert.ok(signArgs.length > 0);
  });

  it('HTTP errors are caught and logged, not thrown', async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' })
    );

    // Should not throw
    await assert.doesNotReject(
      () => client.publish('/db/public/messages/INSERT', [{ id: '1' }])
    );
  });

  it('fetch rejection is caught and logged, not thrown', async () => {
    fetchMock.mock.mockImplementation(() =>
      Promise.reject(new Error('network error'))
    );

    // Should not throw
    await assert.doesNotReject(
      () => client.publish('/db/public/messages/INSERT', [{ id: '1' }])
    );
  });
});
