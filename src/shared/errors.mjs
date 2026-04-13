export const ERRORS = {
  INVALID_EVENT: 'event must be INSERT, UPDATE, or DELETE',
  TABLE_REQUIRED: 'table is required',
  SCHEMA_INVALID_CHARS: 'schema contains characters not allowed in AppSync channel segments',
  SCHEMA_TOO_LONG: 'schema exceeds 50-character AppSync segment limit',
  TABLE_INVALID_CHARS: 'table contains characters not allowed in AppSync channel segments',
  TABLE_TOO_LONG: 'table exceeds 50-character AppSync segment limit',
  NEW_ROW_REQUIRED: 'newRow is required for INSERT and UPDATE events',
  OLD_ROW_REQUIRED: 'oldRow is required for UPDATE and DELETE events',
  PAYLOAD_TOO_LARGE: 'event payload exceeds 240 KB limit',
  BROADCAST_EVENT_INVALID: 'broadcast event name must match [A-Za-z0-9-]+ and be at most 50 characters',
  CHANNEL_NAME_INVALID: 'channel name must match [A-Za-z0-9-]+ and be at most 50 characters',
  BROADCAST_PAYLOAD_TOO_LARGE: 'payload exceeds 240 KB limit',
};

export const VALID_EVENTS = ['INSERT', 'UPDATE', 'DELETE'];
export const MAX_SEGMENT_LENGTH = 50;
export const MAX_PAYLOAD_BYTES = 240 * 1024;
