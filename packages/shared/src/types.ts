export type Platform = "x";

export type MessageDirection = "inbound" | "outbound";

export type JobStatus = "queued" | "processing" | "done" | "failed";

export type JobType = "respond_to_inbound_dm" | "ingest_webhook_receipt";

export type InboundDmEvent = {
  platform: Platform;
  platformMessageId: string;
  platformUserId: string;
  platformUserHandle?: string;
  receivedAtIso: string;
  text: string;
};

export type RespondToInboundDmJobPayload = {
  inboundMessageId: string;
  platformUserId: string;
};

export type IngestWebhookReceiptJobPayload = {
  receiptId: string;
};

export type QueueJobPayload = RespondToInboundDmJobPayload | IngestWebhookReceiptJobPayload;

export type ConversationStatus = "active" | "blocked";

export type DbUser = {
  id: string;
  platform: Platform;
  platform_user_id: string;
  handle: string | null;
  created_at: string;
  updated_at: string;
};

export type DbConversation = {
  id: string;
  user_id: string;
  status: ConversationStatus;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbMessage = {
  id: string;
  conversation_id: string;
  platform: Platform;
  direction: MessageDirection;
  platform_message_id: string | null;
  text_content: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type DbJob = {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  dedupe_key: string;
  attempt_count: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  error_code: string | null;
  error_message: string | null;
  error_stack: string | null;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbOutboundSendAttempt = {
  id: string;
  inbound_message_platform_id: string;
  conversation_id: string;
  platform: Platform;
  recipient_platform_user_id: string;
  reply_text: string;
  outbound_platform_message_id: string;
  sent_at: string;
  created_at: string;
  updated_at: string;
};

export type DbWebhookReceipt = {
  id: string;
  provider: Platform;
  request_id: string;
  signature_header: string | null;
  payload: Record<string, unknown>;
  status: "pending" | "processed" | "failed";
  last_error: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};
