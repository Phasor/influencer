import type { InboundDmEvent } from "./types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

function parseCreatedTimestampToIso(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Invalid X DM payload: created_timestamp is required.");
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Invalid X DM payload: created_timestamp must be a positive epoch value.");
  }

  return new Date(numeric).toISOString();
}

function extractUserHandle(root: JsonRecord, senderId: string): string | undefined {
  const users = asRecord(root.users);
  if (!users) {
    return undefined;
  }

  const sender = asRecord(users[senderId]);
  if (!sender) {
    return undefined;
  }

  return asNonEmptyString(sender.screen_name) ?? undefined;
}

export function normalizeXInboundDmEvent(rawPayload: unknown): InboundDmEvent {
  const root = asRecord(rawPayload);
  if (!root) {
    throw new Error("Invalid X DM payload: expected an object.");
  }

  const events = root.direct_message_events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("Invalid X DM payload: direct_message_events is required.");
  }

  const firstEvent = asRecord(events[0]);
  if (!firstEvent) {
    throw new Error("Invalid X DM payload: first direct message event is invalid.");
  }

  const eventType = asNonEmptyString(firstEvent.type);
  if (eventType !== "message_create") {
    throw new Error("Invalid X DM payload: unsupported direct message event type.");
  }

  const platformMessageId = asNonEmptyString(firstEvent.id);
  if (!platformMessageId) {
    throw new Error("Invalid X DM payload: event id is required.");
  }

  const messageCreate = asRecord(firstEvent.message_create);
  if (!messageCreate) {
    throw new Error("Invalid X DM payload: message_create is required.");
  }

  const platformUserId = asNonEmptyString(messageCreate.sender_id);
  if (!platformUserId) {
    throw new Error("Invalid X DM payload: sender_id is required.");
  }

  const messageData = asRecord(messageCreate.message_data);
  const text = messageData ? asNonEmptyString(messageData.text) : null;
  if (!text) {
    throw new Error("Invalid X DM payload: message text is required.");
  }

  const platformUserHandle = extractUserHandle(root, platformUserId);

  return {
    platform: "x",
    platformMessageId,
    platformUserId,
    ...(platformUserHandle ? { platformUserHandle } : {}),
    receivedAtIso: parseCreatedTimestampToIso(firstEvent.created_timestamp),
    text
  };
}
