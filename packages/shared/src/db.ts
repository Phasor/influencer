import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type {
  DbConversation,
  DbJob,
  DbMessage,
  DbOutboundSendAttempt,
  DbWebhookReceipt,
  DbUser,
  JobType,
  MessageDirection,
  Platform,
  QueueJobPayload
} from "./types";

type JsonObject = Record<string, unknown>;

export type InsertMessageInput = {
  conversationId: string;
  direction: MessageDirection;
  text: string;
  occurredAtIso: string;
  platformMessageId?: string;
  metadata?: JsonObject;
  platform?: Platform;
};

export type EnqueueJobInput = {
  type: JobType;
  payload: QueueJobPayload;
  dedupeKey: string;
  runAfterIso?: string;
};

export type ClaimNextJobInput = {
  workerId: string;
  nowIso?: string;
  staleLockMs?: number;
};

export type MarkJobFailedInput = {
  jobId: string;
  attemptCount: number;
  maxAttempts: number;
  baseDelayMs: number;
  nowIso?: string;
  errorCode?: string;
  errorMessage: string;
  errorStack?: string;
};

export type RecordOutboundSendAttemptInput = {
  inboundMessagePlatformId: string;
  conversationId: string;
  recipientPlatformUserId: string;
  replyText: string;
  outboundPlatformMessageId: string;
  sentAtIso: string;
  platform?: Platform;
};

export type ConsumeRateLimitInput = {
  userId: string;
  scope: string;
  windowSeconds: number;
  maxCount: number;
  nowIso?: string;
};

export type RateLimitDecision = {
  allowed: boolean;
  count: number;
  windowStartIso: string;
};

export type JobFailureTransition = {
  nextStatus: "queued" | "failed";
  nextRunAfterIso: string | null;
};

export type ConversationContext = {
  conversation: DbConversation;
  summary: string | null;
  facts: Array<{
    fact_key: string;
    fact_value: string;
    confidence: number | null;
  }>;
  recentMessages: DbMessage[];
};

export function createSupabaseServiceClient(
  supabaseUrl: string,
  serviceRoleKey: string
): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function dedupeKeyForInboundMessage(platformMessageId: string): string {
  return `x_dm_inbound:${platformMessageId}`;
}

export function dedupeKeyForWebhookReceipt(receiptId: string): string {
  return `x_webhook_receipt:${receiptId}`;
}

export function computeRetryDelayMs(attemptCount: number, baseDelayMs: number): number {
  if (attemptCount < 1) {
    throw new Error("attemptCount must be >= 1");
  }
  if (baseDelayMs < 1) {
    throw new Error("baseDelayMs must be >= 1");
  }
  return baseDelayMs * 2 ** (attemptCount - 1);
}

export function computeStaleLockCutoffIso(nowIso: string, staleLockMs: number): string {
  if (staleLockMs < 1) {
    throw new Error("staleLockMs must be >= 1");
  }
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("nowIso must be a valid ISO timestamp");
  }
  return new Date(nowMs - staleLockMs).toISOString();
}

export function computeJobFailureTransition(params: {
  attemptCount: number;
  maxAttempts: number;
  baseDelayMs: number;
  now: Date;
}): JobFailureTransition {
  const { attemptCount, maxAttempts, baseDelayMs, now } = params;
  if (attemptCount >= maxAttempts) {
    return {
      nextStatus: "failed",
      nextRunAfterIso: null
    };
  }

  const delayMs = computeRetryDelayMs(attemptCount, baseDelayMs);
  const nextRunAfter = new Date(now.getTime() + delayMs);

  return {
    nextStatus: "queued",
    nextRunAfterIso: nextRunAfter.toISOString()
  };
}

export async function upsertUser(
  client: SupabaseClient,
  platformUserId: string,
  handle?: string,
  platform: Platform = "x"
): Promise<DbUser> {
  const { data, error } = await client
    .from("users")
    .upsert(
      {
        platform,
        platform_user_id: platformUserId,
        handle: handle ?? null
      },
      { onConflict: "platform,platform_user_id" }
    )
    .select()
    .single();

  if (error || !data) {
    throw new Error(`upsertUser failed: ${error?.message ?? "no data returned"}`);
  }

  return data as unknown as DbUser;
}

export async function getOrCreateConversation(
  client: SupabaseClient,
  platformUserId: string,
  handle?: string,
  platform: Platform = "x"
): Promise<DbConversation> {
  const user = await upsertUser(client, platformUserId, handle, platform);

  const { data: existing, error: existingError } = await client
    .from("conversations")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingError) {
    throw new Error(`getOrCreateConversation select failed: ${existingError.message}`);
  }

  if (existing) {
    return existing as unknown as DbConversation;
  }

  const { data: inserted, error: insertError } = await client
    .from("conversations")
    .insert({
      user_id: user.id
    })
    .select()
    .single();

  if (insertError || !inserted) {
    throw new Error(`getOrCreateConversation insert failed: ${insertError?.message ?? "no data"}`);
  }

  return inserted as unknown as DbConversation;
}

export async function insertMessage(
  client: SupabaseClient,
  input: InsertMessageInput
): Promise<DbMessage> {
  const { data, error } = await client
    .from("messages")
    .insert({
      conversation_id: input.conversationId,
      platform: input.platform ?? "x",
      direction: input.direction,
      platform_message_id: input.platformMessageId ?? null,
      text_content: input.text,
      occurred_at: input.occurredAtIso,
      metadata: input.metadata ?? {}
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`insertMessage failed: ${error?.message ?? "no data returned"}`);
  }

  return data as unknown as DbMessage;
}

export async function fetchMessageByPlatformMessageId(
  client: SupabaseClient,
  platformMessageId: string
): Promise<DbMessage | null> {
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("platform_message_id", platformMessageId)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchMessageByPlatformMessageId failed: ${error.message}`);
  }

  return (data as DbMessage | null) ?? null;
}

export async function enqueueJob(
  client: SupabaseClient,
  input: EnqueueJobInput
): Promise<{ job: DbJob; created: boolean }> {
  const { data, error } = await client
    .from("jobs")
    .upsert(
      {
        type: input.type,
        status: "queued",
        payload: input.payload,
        dedupe_key: input.dedupeKey,
        run_after: input.runAfterIso ?? new Date().toISOString()
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`enqueueJob upsert failed: ${error.message}`);
  }

  if (data) {
    return {
      job: data as unknown as DbJob,
      created: true
    };
  }

  const { data: existing, error: existingError } = await client
    .from("jobs")
    .select("*")
    .eq("dedupe_key", input.dedupeKey)
    .single();

  if (existingError || !existing) {
    throw new Error(`enqueueJob read existing failed: ${existingError?.message ?? "no data"}`);
  }

  return {
    job: existing as unknown as DbJob,
    created: false
  };
}

export async function insertWebhookReceipt(
  client: SupabaseClient,
  input: {
    provider: Platform;
    requestId: string;
    signatureHeader: string | null;
    payload: Record<string, unknown>;
  }
): Promise<DbWebhookReceipt> {
  const { data, error } = await client
    .from("webhook_receipts")
    .insert({
      provider: input.provider,
      request_id: input.requestId,
      signature_header: input.signatureHeader,
      payload: input.payload,
      status: "pending"
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`insertWebhookReceipt failed: ${error?.message ?? "no data returned"}`);
  }

  return data as unknown as DbWebhookReceipt;
}

export async function fetchWebhookReceiptById(
  client: SupabaseClient,
  receiptId: string
): Promise<DbWebhookReceipt | null> {
  const { data, error } = await client
    .from("webhook_receipts")
    .select("*")
    .eq("id", receiptId)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchWebhookReceiptById failed: ${error.message}`);
  }

  return (data as DbWebhookReceipt | null) ?? null;
}

export async function markWebhookReceiptProcessed(
  client: SupabaseClient,
  receiptId: string,
  processedAtIso: string
): Promise<void> {
  const { error } = await client
    .from("webhook_receipts")
    .update({
      status: "processed",
      processed_at: processedAtIso,
      last_error: null
    })
    .eq("id", receiptId);

  if (error) {
    throw new Error(`markWebhookReceiptProcessed failed: ${error.message}`);
  }
}

export async function markWebhookReceiptFailed(
  client: SupabaseClient,
  receiptId: string,
  errorMessage: string
): Promise<void> {
  const { error } = await client
    .from("webhook_receipts")
    .update({
      status: "failed",
      last_error: errorMessage
    })
    .eq("id", receiptId);

  if (error) {
    throw new Error(`markWebhookReceiptFailed failed: ${error.message}`);
  }
}

export async function claimNextJob(
  client: SupabaseClient,
  input: ClaimNextJobInput
): Promise<DbJob | null> {
  const nowIso = input.nowIso ?? new Date().toISOString();

  const { data: nextJob, error: fetchError } = await client
    .from("jobs")
    .select("*")
    .eq("status", "queued")
    .lte("run_after", nowIso)
    .order("run_after", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`claimNextJob select failed: ${fetchError.message}`);
  }

  if (!nextJob) {
    if (!input.staleLockMs) {
      return null;
    }

    const staleCutoffIso = computeStaleLockCutoffIso(nowIso, input.staleLockMs);
    const { data: staleJob, error: staleFetchError } = await client
      .from("jobs")
      .select("*")
      .eq("status", "processing")
      .lte("locked_at", staleCutoffIso)
      .order("locked_at", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (staleFetchError) {
      throw new Error(`claimNextJob stale select failed: ${staleFetchError.message}`);
    }

    if (!staleJob) {
      return null;
    }

    const staleAttemptCount = (staleJob as { attempt_count: number }).attempt_count + 1;
    const staleLockedAt = (staleJob as { locked_at: string | null }).locked_at;
    const { data: reclaimed, error: reclaimError } = await client
      .from("jobs")
      .update({
        status: "processing",
        locked_at: nowIso,
        locked_by: input.workerId,
        last_attempt_at: nowIso,
        attempt_count: staleAttemptCount
      })
      .eq("id", (staleJob as { id: string }).id)
      .eq("status", "processing")
      .eq("locked_at", staleLockedAt)
      .select()
      .maybeSingle();

    if (reclaimError) {
      throw new Error(`claimNextJob stale update failed: ${reclaimError.message}`);
    }

    if (!reclaimed) {
      return null;
    }

    return reclaimed as unknown as DbJob;
  }

  const nextAttemptCount = (nextJob as { attempt_count: number }).attempt_count + 1;

  const { data: claimed, error: claimError } = await client
    .from("jobs")
    .update({
      status: "processing",
      locked_at: nowIso,
      locked_by: input.workerId,
      last_attempt_at: nowIso,
      attempt_count: nextAttemptCount
    })
    .eq("id", (nextJob as { id: string }).id)
    .eq("status", "queued")
    .select()
    .maybeSingle();

  if (claimError) {
    throw new Error(`claimNextJob update failed: ${claimError.message}`);
  }

  if (!claimed) {
    return null;
  }

  return claimed as unknown as DbJob;
}

export async function markJobDone(client: SupabaseClient, jobId: string): Promise<void> {
  const { error } = await client
    .from("jobs")
    .update({
      status: "done",
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_message: null,
      error_stack: null
    })
    .eq("id", jobId)
    .eq("status", "processing");

  if (error) {
    throw new Error(`markJobDone failed: ${error.message}`);
  }
}

export async function fetchOutboundSendAttemptByInboundMessageId(
  client: SupabaseClient,
  inboundMessagePlatformId: string
): Promise<DbOutboundSendAttempt | null> {
  const { data, error } = await client
    .from("outbound_send_attempts")
    .select("*")
    .eq("inbound_message_platform_id", inboundMessagePlatformId)
    .maybeSingle();

  if (error) {
    throw new Error(`fetchOutboundSendAttemptByInboundMessageId failed: ${error.message}`);
  }

  return (data as DbOutboundSendAttempt | null) ?? null;
}

export async function recordOutboundSendAttempt(
  client: SupabaseClient,
  input: RecordOutboundSendAttemptInput
): Promise<{ attempt: DbOutboundSendAttempt; created: boolean }> {
  const { data, error } = await client
    .from("outbound_send_attempts")
    .upsert(
      {
        inbound_message_platform_id: input.inboundMessagePlatformId,
        conversation_id: input.conversationId,
        platform: input.platform ?? "x",
        recipient_platform_user_id: input.recipientPlatformUserId,
        reply_text: input.replyText,
        outbound_platform_message_id: input.outboundPlatformMessageId,
        sent_at: input.sentAtIso
      },
      { onConflict: "inbound_message_platform_id", ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`recordOutboundSendAttempt upsert failed: ${error.message}`);
  }

  if (data) {
    return {
      attempt: data as DbOutboundSendAttempt,
      created: true
    };
  }

  const existing = await fetchOutboundSendAttemptByInboundMessageId(
    client,
    input.inboundMessagePlatformId
  );
  if (!existing) {
    throw new Error("recordOutboundSendAttempt read existing failed: no data");
  }

  return {
    attempt: existing,
    created: false
  };
}

export async function updateConversationLastMessageAt(
  client: SupabaseClient,
  conversationId: string,
  occurredAtIso: string
): Promise<void> {
  const { error } = await client
    .from("conversations")
    .update({
      last_message_at: occurredAtIso
    })
    .eq("id", conversationId);

  if (error) {
    throw new Error(`updateConversationLastMessageAt failed: ${error.message}`);
  }
}

export async function countConversationInboundMessages(
  client: SupabaseClient,
  conversationId: string
): Promise<number> {
  const { count, error } = await client
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound");

  if (error) {
    throw new Error(`countConversationInboundMessages failed: ${error.message}`);
  }

  return count ?? 0;
}

export async function upsertConversationSummary(
  client: SupabaseClient,
  conversationId: string,
  summary: string
): Promise<void> {
  const { error } = await client
    .from("memory_summaries")
    .upsert(
      {
        conversation_id: conversationId,
        summary
      },
      { onConflict: "conversation_id" }
    );

  if (error) {
    throw new Error(`upsertConversationSummary failed: ${error.message}`);
  }
}

export async function consumeRateLimit(
  client: SupabaseClient,
  input: ConsumeRateLimitInput
): Promise<RateLimitDecision> {
  if (input.windowSeconds < 1) {
    throw new Error("windowSeconds must be >= 1");
  }
  if (input.maxCount < 1) {
    throw new Error("maxCount must be >= 1");
  }

  const now = new Date(input.nowIso ?? new Date().toISOString());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("nowIso must be a valid ISO timestamp");
  }

  const windowMs = input.windowSeconds * 1000;
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const windowStartIso = new Date(windowStartMs).toISOString();

  const { data: existing, error: existingError } = await client
    .from("rate_limits")
    .select("id, request_count")
    .eq("user_id", input.userId)
    .eq("scope", input.scope)
    .eq("window_start", windowStartIso)
    .maybeSingle();

  if (existingError) {
    throw new Error(`consumeRateLimit read failed: ${existingError.message}`);
  }

  if (!existing) {
    const { data: inserted, error: insertError } = await client
      .from("rate_limits")
      .insert({
        user_id: input.userId,
        scope: input.scope,
        window_start: windowStartIso,
        window_seconds: input.windowSeconds,
        request_count: 1
      })
      .select("request_count")
      .single();

    if (insertError || !inserted) {
      throw new Error(`consumeRateLimit insert failed: ${insertError?.message ?? "no data returned"}`);
    }

    return {
      allowed: true,
      count: 1,
      windowStartIso
    };
  }

  const nextCount = (existing as { request_count: number }).request_count + 1;
  const { data, error } = await client
    .from("rate_limits")
    .update({
      request_count: nextCount
    })
    .eq("id", (existing as { id: string }).id)
    .select("request_count, window_start")
    .single();

  if (error || !data) {
    throw new Error(`consumeRateLimit update failed: ${error?.message ?? "no data returned"}`);
  }

  const count = (data as { request_count: number }).request_count;
  return {
    allowed: count <= input.maxCount,
    count,
    windowStartIso
  };
}

export async function markJobFailed(client: SupabaseClient, input: MarkJobFailedInput): Promise<void> {
  const now = new Date(input.nowIso ?? new Date().toISOString());
  const transition = computeJobFailureTransition({
    attemptCount: input.attemptCount,
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs,
    now
  });

  const { error } = await client
    .from("jobs")
    .update({
      status: transition.nextStatus,
      run_after: transition.nextRunAfterIso ?? now.toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage,
      error_stack: input.errorStack ?? null,
      last_attempt_at: now.toISOString()
    })
    .eq("id", input.jobId)
    .eq("status", "processing");

  if (error) {
    throw new Error(`markJobFailed failed: ${error.message}`);
  }
}

export async function fetchConversationContext(
  client: SupabaseClient,
  conversationId: string,
  maxMessages: number
): Promise<ConversationContext> {
  const { data: conversation, error: conversationError } = await client
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .single();

  if (conversationError || !conversation) {
    throw new Error(
      `fetchConversationContext conversation lookup failed: ${
        conversationError?.message ?? "not found"
      }`
    );
  }

  const { data: summaryRow, error: summaryError } = await client
    .from("memory_summaries")
    .select("summary")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (summaryError) {
    throw new Error(`fetchConversationContext summary lookup failed: ${summaryError.message}`);
  }

  const { data: facts, error: factsError } = await client
    .from("memory_facts")
    .select("fact_key, fact_value, confidence")
    .eq("conversation_id", conversationId)
    .order("updated_at", { ascending: false })
    .limit(10);

  if (factsError) {
    throw new Error(`fetchConversationContext facts lookup failed: ${factsError.message}`);
  }

  const { data: messages, error: messagesError } = await client
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("occurred_at", { ascending: false })
    .limit(maxMessages);

  if (messagesError) {
    throw new Error(`fetchConversationContext messages lookup failed: ${messagesError.message}`);
  }

  return {
    conversation: conversation as unknown as DbConversation,
    summary: (summaryRow as { summary: string } | null)?.summary ?? null,
    facts: (facts ?? []) as Array<{
      fact_key: string;
      fact_value: string;
      confidence: number | null;
    }>,
    recentMessages: ((messages ?? []) as DbMessage[]).reverse()
  };
}
