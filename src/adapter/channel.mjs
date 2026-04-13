import {
  pgChangesChannel,
  broadcastChannel,
} from '../shared/protocol.mjs';
import { MAX_PAYLOAD_BYTES } from '../shared/errors.mjs';
import { formatBroadcastEvent } from './broadcast.mjs';
import { AppSyncWebSocketClient } from './websocket.mjs';

export class RealtimeChannel {
  constructor(name, wsClient, token) {
    this.name = name;
    this._wsClient = wsClient;
    this._token = token;
    this._listeners = [];
    this._subscriptionIds = [];
    this._subscribed = false;
  }

  on(type, filter, callback) {
    let channel = null;
    let error = null;

    try {
      if (type === 'postgres_changes') {
        const { schema = 'public', table, event } = filter;
        channel = pgChangesChannel(schema, table, event);
      } else if (type === 'broadcast') {
        channel = broadcastChannel(this.name, filter.event);
      }
    } catch (err) {
      error = err;
    }

    this._listeners.push({ channel, callback, type, filter, error });
    return this;
  }

  async subscribe(statusCb) {
    if (this._subscribed) return;

    for (const listener of this._listeners) {
      if (listener.error) throw listener.error;
    }

    await this._wsClient.connect();

    try {
      for (const listener of this._listeners) {
        const subId = await this._wsClient.subscribe(
          listener.channel,
          this._token,
          listener.callback,
        );
        this._subscriptionIds.push(subId);
      }
      this._subscribed = true;
      if (statusCb) statusCb('SUBSCRIBED');
    } catch (err) {
      if (statusCb) statusCb('CHANNEL_ERROR', err);
    }
  }

  async send({ type, event, payload }) {
    if (type === 'broadcast') {
      const channel = broadcastChannel(this.name, event);
      const formatted = formatBroadcastEvent(event, payload);

      const serialized = JSON.stringify(formatted);
      if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
        return;
      }

      await this._wsClient.publish(channel, [formatted], this._token);
    }
  }

  async unsubscribe() {
    for (const subId of this._subscriptionIds) {
      await this._wsClient.unsubscribe(subId);
    }
    this._subscriptionIds = [];
    this._subscribed = false;
  }
}

export function createRealtimeAdapter({
  httpUrl,
  wsUrl,
  token,
  _wsClient,
}) {
  const wsClient =
    _wsClient ||
    new AppSyncWebSocketClient({ wsUrl, httpUrl, token });
  const channels = new Map();

  return {
    channel(name) {
      if (!channels.has(name)) {
        channels.set(
          name,
          new RealtimeChannel(name, wsClient, token),
        );
      }
      return channels.get(name);
    },

    async removeChannel(channel) {
      await channel.unsubscribe();
      channels.delete(channel.name);
    },
  };
}
