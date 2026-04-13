import { AppSyncEventsClient } from './appsync-client.mjs';
import { pgChangesChannel } from '../shared/protocol.mjs';
import { ERRORS, VALID_EVENTS, MAX_PAYLOAD_BYTES }
  from '../shared/errors.mjs';

export function createEventPublisher({ apiEndpoint, region, _client }) {
  const client = _client || new AppSyncEventsClient({
    apiEndpoint, region,
  });
  return { publishChange, publish: client.publish.bind(client) };

  async function publishChange({
    schema = 'public', table, event, newRow, oldRow,
  } = {}) {
    try {
      if (!VALID_EVENTS.includes(event)) {
        throw new Error(ERRORS.INVALID_EVENT);
      }
      if (!table) {
        throw new Error(ERRORS.TABLE_REQUIRED);
      }
      if ((event === 'INSERT' || event === 'UPDATE') && !newRow) {
        throw new Error(ERRORS.NEW_ROW_REQUIRED);
      }
      if ((event === 'UPDATE' || event === 'DELETE') && !oldRow) {
        throw new Error(ERRORS.OLD_ROW_REQUIRED);
      }

      const channel = pgChangesChannel(schema, table, event);

      const payload = {
        schema,
        table,
        commit_timestamp: new Date().toISOString(),
        eventType: event,
        new: newRow || {},
        old: oldRow || {},
        errors: null,
      };

      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error(ERRORS.PAYLOAD_TOO_LARGE);
      }

      await client.publish(channel, [payload]);
    } catch (err) {
      console.error('events-lambda: publish failed', err.message);
    }
  }
}
