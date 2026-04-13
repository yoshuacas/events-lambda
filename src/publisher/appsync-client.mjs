import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Sha256 } from '@aws-crypto/sha256-js';

export class AppSyncEventsClient {
  constructor({ apiEndpoint, region, signer, fetch: fetchFn }) {
    this.endpoint = apiEndpoint;
    this.signer = signer || new SignatureV4({
      service: 'appsync',
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
    this.fetch = fetchFn || globalThis.fetch;
  }

  async publish(channel, events) {
    try {
      const stringifiedEvents = events.map((e) => JSON.stringify(e));
      const body = JSON.stringify({ channel, events: stringifiedEvents });

      const url = new URL(this.endpoint);
      const request = {
        method: 'POST',
        hostname: url.hostname,
        path: '/event',
        protocol: url.protocol,
        headers: {
          'content-type': 'application/json',
          host: url.hostname,
        },
        body,
      };

      const signed = await this.signer.sign(request);

      const response = await this.fetch(`${this.endpoint}/event`, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body,
      });

      if (!response.ok) {
        console.error(
          `events-lambda: publish failed with status ${response.status} ${response.statusText}`
        );
      }
    } catch (err) {
      console.error('events-lambda: publish failed', err);
    }
  }
}
