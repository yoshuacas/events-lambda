// Format a broadcast payload for sending via WebSocket
export function formatBroadcastEvent(eventName, payload) {
  return {
    event: eventName,
    payload,
    type: 'broadcast',
  };
}

// Parse an incoming broadcast event for delivery to callback
export function parseBroadcastEvent(rawEvent) {
  // rawEvent is already parsed from the data message.
  // Return as-is — the format matches what the callback
  // expects: { event, payload, type }
  return rawEvent;
}
