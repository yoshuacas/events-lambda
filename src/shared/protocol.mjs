export function sanitizeSegment(name) {
  const sanitized = name.replace(/_/g, '-');
  if (!/^[A-Za-z0-9-]+$/.test(sanitized)) {
    throw new Error(
      `"${name}" contains characters not allowed in AppSync channel segments`
    );
  }
  if (sanitized.length > 50) {
    throw new Error(
      `"${name}" exceeds 50-character AppSync segment limit`
    );
  }
  return sanitized;
}

export function pgChangesChannel(schema, table, event) {
  return `/db/${sanitizeSegment(schema)}/${sanitizeSegment(table)}/${event}`;
}

export function broadcastChannel(channelName, eventName) {
  return `/broadcast/${sanitizeSegment(channelName)}/${sanitizeSegment(eventName)}`;
}

export function presenceChannel(channelName) {
  return `/presence/${sanitizeSegment(channelName)}`;
}
