import { randomUUID } from 'node:crypto';

function base64urlEncode(str) {
  if (typeof btoa === 'function') {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return Buffer.from(str).toString('base64url');
}

export class AppSyncWebSocketClient {
  constructor({ wsUrl, httpUrl, token, WebSocket }) {
    this.wsUrl = wsUrl;
    this.httpUrl = httpUrl;
    this.token = token;
    this.WebSocketImpl = WebSocket || globalThis.WebSocket;
    this.ws = null;
    this.subscriptions = new Map();
    this.pendingOps = new Map();
    this.connectionTimeoutMs = null;
    this.keepaliveTimer = null;
    this._lastKeepalive = null;
    this._errorHandler = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
  }

  onError(handler) {
    this._errorHandler = handler;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      const header = JSON.stringify({
        host: this.httpUrl,
        Authorization: 'Bearer ' + this.token,
      });
      const encoded = base64urlEncode(header);
      const url = `${this.wsUrl}/event/realtime`;
      const protocols = ['aws-appsync-event-ws', 'header-' + encoded];

      this.ws = new this.WebSocketImpl(url, protocols);

      this.ws.addEventListener('open', () => {
        this.ws.send(JSON.stringify({ type: 'connection_init' }));
      });

      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      });

      this.ws.addEventListener('error', (event) => {
        if (this._connectReject) {
          this._connectReject(event instanceof Error ? event : new Error('WebSocket error'));
          this._connectReject = null;
          this._connectResolve = null;
          this._connectPromise = null;
        }
        if (this._errorHandler) {
          this._errorHandler(event);
        }
      });
    });

    return this._connectPromise;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'connection_ack':
        this.connectionTimeoutMs = msg.connectionTimeoutMs;
        this._lastKeepalive = Date.now();
        this._startKeepaliveTimer();
        if (this._connectResolve) {
          this._connectResolve();
          this._connectResolve = null;
          this._connectReject = null;
        }
        break;

      case 'ka':
        this._lastKeepalive = Date.now();
        this._resetKeepaliveTimer();
        break;

      case 'data': {
        const callback = this.subscriptions.get(msg.id);
        if (callback) {
          for (const eventStr of msg.event) {
            callback(JSON.parse(eventStr));
          }
        }
        break;
      }

      case 'subscribe_success': {
        const op = this.pendingOps.get(msg.id);
        if (op) {
          this.pendingOps.delete(msg.id);
          op.resolve(msg.id);
        }
        break;
      }

      case 'subscribe_error': {
        const op = this.pendingOps.get(msg.id);
        if (op) {
          this.pendingOps.delete(msg.id);
          this.subscriptions.delete(msg.id);
          op.reject(
            new Error(msg.errors?.[0]?.message || 'Subscribe failed')
          );
        }
        break;
      }

      case 'publish_success': {
        const op = this.pendingOps.get(msg.id);
        if (op) {
          this.pendingOps.delete(msg.id);
          op.resolve();
        }
        break;
      }

      case 'publish_error': {
        const op = this.pendingOps.get(msg.id);
        if (op) {
          this.pendingOps.delete(msg.id);
          op.reject(
            new Error(msg.errors?.[0]?.message || 'Publish failed')
          );
        }
        break;
      }

      case 'unsubscribe_success': {
        const op = this.pendingOps.get(msg.id);
        if (op) {
          this.pendingOps.delete(msg.id);
          this.subscriptions.delete(msg.id);
          op.resolve();
        }
        break;
      }

      case 'error':
        if (this._errorHandler) {
          this._errorHandler(msg);
        }
        break;
    }
  }

  subscribe(channel, token, callback) {
    const id = randomUUID();
    this.subscriptions.set(id, callback);

    return new Promise((resolve, reject) => {
      this.pendingOps.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'subscribe',
          id,
          channel,
          authorization: {
            host: this.httpUrl,
            Authorization: 'Bearer ' + token,
          },
        })
      );
    });
  }

  publish(channel, events, token) {
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingOps.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'publish',
          id,
          channel,
          events: events.map((e) => JSON.stringify(e)),
          authorization: {
            host: this.httpUrl,
            Authorization: 'Bearer ' + token,
          },
        })
      );
    });
  }

  unsubscribe(subscriptionId) {
    return new Promise((resolve, reject) => {
      this.pendingOps.set(subscriptionId, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          type: 'unsubscribe',
          id: subscriptionId,
        })
      );
    });
  }

  _startKeepaliveTimer() {
    if (this.connectionTimeoutMs) {
      this.keepaliveTimer = setTimeout(() => {
        // Reconnection handled in Phase 5
      }, this.connectionTimeoutMs);
    }
  }

  _resetKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
    }
    this._startKeepaliveTimer();
  }
}
