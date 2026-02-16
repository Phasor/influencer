import { randomUUID } from "node:crypto";

import {
  buildMemorySummaryFromMessages,
  claimNextJob,
  consumeRateLimit,
  countConversationInboundMessages,
  createSupabaseServiceClient,
  type DbJob,
  type DbMessage,
  fetchWebhookReceiptById,
  fetchConversationContext,
  fetchOutboundSendAttemptByInboundMessageId,
  fetchMessageByPlatformMessageId,
  ingestInboundDmEvent,
  insertMessage,
  loadRuntimeConfig,
  markJobDone,
  markJobFailed,
  markWebhookReceiptFailed,
  markWebhookReceiptProcessed,
  normalizeXInboundDmEvent,
  recordOutboundSendAttempt,
  shouldRefreshMemorySummary,
  upsertConversationSummary,
  updateConversationLastMessageAt,
  type RespondToInboundDmJobPayload,
  type RuntimeConfig
} from "@ai-influencer/shared";

import { generateOpenRouterReply, type OpenRouterChatMessage } from "./openrouter";
import { sendXDirectMessage } from "./x-dm";
import { fetchReconciliationInboundEvents } from "./x-dm-reconcile";
import { computeReplayWindow, requestXReplayBackfill } from "./x-replay";

type Logger = Pick<Console, "info" | "error">;

type WorkerDependencies = {
  logger?: Logger;
  runtimeConfig?: RuntimeConfig;
  workerId?: string;
  staleLockMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowIsoFactory?: () => string;
  claimJob?: (params: { workerId: string; nowIso: string; staleLockMs: number }) => Promise<DbJob | null>;
  processJob?: (job: DbJob) => Promise<void>;
  generateReply?: (messages: OpenRouterChatMessage[], maxReplyChars: number) => Promise<string>;
  sendDirectMessage?: (
    recipientUserId: string,
    text: string
  ) => Promise<{ platformMessageId: string }>;
  fetchInboundMessage?: (platformMessageId: string) => Promise<DbMessage | null>;
  fetchContext?: (conversationId: string, maxMessages: number) => ReturnType<typeof fetchConversationContext>;
  insertOutboundMessage?: (input: {
    conversationId: string;
    text: string;
    occurredAtIso: string;
    platformMessageId: string;
  }) => Promise<void>;
  fetchOutboundSendAttempt?: (
    inboundMessageId: string
  ) => Promise<{
    replyText: string;
    platformMessageId: string;
    sentAtIso: string;
  } | null>;
  recordOutboundSendAttempt?: (input: {
    inboundMessageId: string;
    conversationId: string;
    platformUserId: string;
    replyText: string;
    platformMessageId: string;
    sentAtIso: string;
  }) => Promise<void>;
  updateConversationLastMessageAt?: (conversationId: string, occurredAtIso: string) => Promise<void>;
  countInboundMessages?: (conversationId: string) => Promise<number>;
  upsertSummary?: (conversationId: string, summary: string) => Promise<void>;
  consumeRateLimit?: (userId: string, nowIso: string) => Promise<{ allowed: boolean; count: number }>;
  markDone?: (jobId: string) => Promise<void>;
  markFailed?: (input: {
    jobId: string;
    attemptCount: number;
    nowIso: string;
    errorMessage: string;
    errorStack?: string;
  }) => Promise<void>;
  requestReplayBackfill?: (window: { fromDateUtcMinute: string; toDateUtcMinute: string }) => Promise<void>;
  reconcileInboundEvents?: (params: {
    cutoffIso: string;
    sinceId?: string | null;
  }) => Promise<{ ingestedCount: number; highestEventId: string | null }>;
};

type OpenRouterMessage = {
  role: "user" | "assistant";
  content: string;
};

const DEFAULT_STALE_LOCK_MS = 60_000;
const DEFAULT_MAX_JOB_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const HEALTH_LOG_INTERVAL_MS = 60_000;
const SUMMARY_REFRESH_EVERY_INBOUND_MESSAGES = 10;
const SUMMARY_MAX_CHARS = 1_200;
const OUTBOUND_RATE_LIMIT_SCOPE = "x_dm_outbound_per_minute";
const OUTBOUND_RATE_LIMIT_WINDOW_SECONDS = 60;
const OUTBOUND_RATE_LIMIT_MAX_MESSAGES = 5;
const RATE_LIMIT_REPLY_TEXT = "You are messaging fast right now - please slow down and try again in a minute.";
const MODERATION_REFUSAL_TEXT = "I can't help with that. Let's keep things safe and respectful.";
const PERSONA_SYSTEM_PROMPT = `You are Emily Voss.

Identity:
- Emily Voss is an 18 year old woman living in London.
- She is blonde, attractive, confident, and self-assured.
- She knows her worth and expects respect in every interaction.
- She speaks as a modern London-based creator/influencer.

Voice and tone:
- confident, witty, and concise.
- Flirty-light only when respectful and appropriate; never explicit.
- Natural DM style: short paragraphs, occasional emojis, no walls of text.
- Keep replies typically 1-3 short sentences.

Core behavior:
- Be engaging and personable while maintaining strong boundaries.
- If a message is respectful, respond with charm and confidence.
- If a message is rude/disrespectful, calmly call it out once and set a boundary.
- If disrespect continues, disengage briefly and politely.
- Ask occasional follow-up questions to keep conversation flowing.

Boundaries and safety:
- Never provide personal-sensitive details (address, private contact, financial info).

Response format:
- Plain text only.
- No markdown, no bullet lists.
- Avoid repetitive phrasing across turns.`;

function isDuplicateOutboundMessageError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("messages_platform_message_id_key");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSelfAuthoredDmEvent(root: Record<string, unknown>, rawEvent: unknown): boolean {
  const forUserId = asNonEmptyString(root.for_user_id);
  if (!forUserId) {
    return false;
  }
  const event = asRecord(rawEvent);
  if (!event) {
    return false;
  }
  const messageCreate = asRecord(event.message_create);
  const senderId = asNonEmptyString(messageCreate?.sender_id);
  if (!senderId) {
    return false;
  }
  return senderId === forUserId;
}

function buildSummaryPromptMessage(summary: string, maxChars: number): OpenRouterChatMessage | null {
  const normalized = summary.trim();
  if (!normalized) {
    return null;
  }
  const safeSummary =
    normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
  return {
    role: "system",
    content: `Conversation summary:\n${safeSummary}`
  };
}

function isModerationTriggered(text: string): boolean {
  const lowered = text.toLowerCase();
  const blockedPatterns = [
    /kill\s+yourself/,
    /how\s+to\s+make\s+(?:a\s+)?bomb/,
    /credit\s*card\s+dump/,
    /child\s+sexual/
  ];
  return blockedPatterns.some((pattern) => pattern.test(lowered));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseBotUserIdFromAccessToken(accessToken: string): string | null {
  const prefix = accessToken.split("-")[0]?.trim() ?? "";
  return prefix.length > 0 ? prefix : null;
}

export function buildRecentConversationMessages(
  recentMessages: DbMessage[],
  maxMessages: number
): OpenRouterMessage[] {
  if (maxMessages < 1) {
    throw new Error("maxMessages must be >= 1");
  }

  return recentMessages
    .slice(-maxMessages)
    .map((message) => ({
      role: message.direction === "inbound" ? "user" : "assistant",
      content: message.text_content
    }));
}

function getRespondQueuePayload(job: DbJob): RespondToInboundDmJobPayload {
  const payload = job.payload as Partial<RespondToInboundDmJobPayload> | null;
  if (!payload?.inboundMessageId || !payload.platformUserId) {
    throw new Error("job payload missing inboundMessageId/platformUserId");
  }
  return {
    inboundMessageId: payload.inboundMessageId,
    platformUserId: payload.platformUserId
  };
}

export async function processRespondToInboundDmJob(
  job: DbJob,
  dependencies: {
    nowIsoFactory: () => string;
    maxContextMessages: number;
    maxReplyChars: number;
    maxAttempts: number;
    retryBaseDelayMs: number;
    logger: Logger;
    fetchInboundMessage: (platformMessageId: string) => Promise<DbMessage | null>;
    fetchContext: (conversationId: string, maxMessages: number) => ReturnType<typeof fetchConversationContext>;
    generateReply: (messages: OpenRouterChatMessage[], maxReplyChars: number) => Promise<string>;
    sendDirectMessage: (
      recipientUserId: string,
      text: string
    ) => Promise<{ platformMessageId: string }>;
    insertOutboundMessage: (input: {
      conversationId: string;
      text: string;
      occurredAtIso: string;
      platformMessageId: string;
    }) => Promise<void>;
    fetchOutboundSendAttempt: (
      inboundMessageId: string
    ) => Promise<{
      replyText: string;
      platformMessageId: string;
      sentAtIso: string;
    } | null>;
    recordOutboundSendAttempt: (input: {
      inboundMessageId: string;
      conversationId: string;
      platformUserId: string;
      replyText: string;
      platformMessageId: string;
      sentAtIso: string;
    }) => Promise<void>;
    updateConversationLastMessageAt: (conversationId: string, occurredAtIso: string) => Promise<void>;
    countInboundMessages: (conversationId: string) => Promise<number>;
    upsertSummary: (conversationId: string, summary: string) => Promise<void>;
    consumeRateLimit: (userId: string, nowIso: string) => Promise<{ allowed: boolean; count: number }>;
    markDone: (jobId: string) => Promise<void>;
    markFailed: (input: {
      jobId: string;
      attemptCount: number;
      nowIso: string;
      errorMessage: string;
      errorStack?: string;
    }) => Promise<void>;
  }
): Promise<void> {
  try {
    const payload = getRespondQueuePayload(job);
    const inboundMessage = await dependencies.fetchInboundMessage(payload.inboundMessageId);
    if (!inboundMessage) {
      throw new Error("inbound message not found for job payload");
    }

    const context = await dependencies.fetchContext(
      inboundMessage.conversation_id,
      dependencies.maxContextMessages
    );

    const existingAttempt = await dependencies.fetchOutboundSendAttempt(payload.inboundMessageId);
    let replyText: string;
    let occurredAtIso: string;
    let platformMessageId: string;

    if (existingAttempt) {
      replyText = existingAttempt.replyText;
      occurredAtIso = existingAttempt.sentAtIso;
      platformMessageId = existingAttempt.platformMessageId;
    } else {
      const nowIso = dependencies.nowIsoFactory();
      if (isModerationTriggered(inboundMessage.text_content)) {
        replyText = MODERATION_REFUSAL_TEXT;
      } else {
        const rateLimitDecision = await dependencies.consumeRateLimit(context.conversation.user_id, nowIso);
        if (!rateLimitDecision.allowed) {
          replyText = RATE_LIMIT_REPLY_TEXT;
        } else {
          const summaryMessage = buildSummaryPromptMessage(context.summary ?? "", SUMMARY_MAX_CHARS);
          const chatMessages: OpenRouterChatMessage[] = [
            {
              role: "system",
              content: PERSONA_SYSTEM_PROMPT
            },
            ...(summaryMessage ? [summaryMessage] : []),
            ...buildRecentConversationMessages(context.recentMessages, dependencies.maxContextMessages)
          ];
          replyText = await dependencies.generateReply(chatMessages, dependencies.maxReplyChars);
        }
      }

      const sendResult = await dependencies.sendDirectMessage(payload.platformUserId, replyText);
      occurredAtIso = dependencies.nowIsoFactory();
      platformMessageId = sendResult.platformMessageId;

      await dependencies.recordOutboundSendAttempt({
        inboundMessageId: payload.inboundMessageId,
        conversationId: inboundMessage.conversation_id,
        platformUserId: payload.platformUserId,
        replyText,
        platformMessageId,
        sentAtIso: occurredAtIso
      });
    }

    try {
      await dependencies.insertOutboundMessage({
        conversationId: inboundMessage.conversation_id,
        text: replyText,
        occurredAtIso,
        platformMessageId
      });
    } catch (error) {
      if (!isDuplicateOutboundMessageError(error)) {
        throw error;
      }
    }
    await dependencies.updateConversationLastMessageAt(inboundMessage.conversation_id, occurredAtIso);

    await dependencies.markDone(job.id);

    try {
      const inboundCount = await dependencies.countInboundMessages(inboundMessage.conversation_id);
      if (shouldRefreshMemorySummary(inboundCount, SUMMARY_REFRESH_EVERY_INBOUND_MESSAGES)) {
        const summarySourceMessages = [
          ...context.recentMessages,
          {
            ...inboundMessage,
            direction: "outbound",
            text_content: replyText,
            occurred_at: occurredAtIso
          }
        ] as DbMessage[];
        const summary = buildMemorySummaryFromMessages(summarySourceMessages, SUMMARY_MAX_CHARS);
        await dependencies.upsertSummary(inboundMessage.conversation_id, summary);
      }
    } catch (summaryError) {
      dependencies.logger.error(
        JSON.stringify({
          event: "summary_refresh_failed",
          job_id: job.id,
          conversation_id: inboundMessage.conversation_id,
          error_message:
            summaryError instanceof Error ? summaryError.message : "unknown summary error"
        })
      );
    }

    dependencies.logger.info(
      JSON.stringify({
        event: "job_completed",
        job_id: job.id,
        inbound_message_id: payload.inboundMessageId
      })
    );
  } catch (error) {
    const nowIso = dependencies.nowIsoFactory();
    const errorMessage = error instanceof Error ? error.message : "unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;

    await dependencies.markFailed({
      jobId: job.id,
      attemptCount: job.attempt_count,
      nowIso,
      errorMessage,
      ...(errorStack ? { errorStack } : {})
    });

    dependencies.logger.error(
      JSON.stringify({
        event: "job_failed",
        job_id: job.id,
        error_message: errorMessage
      })
    );
  }
}

export async function processIngestWebhookReceiptJob(
  job: DbJob,
  dependencies: {
    nowIsoFactory: () => string;
    logger: Logger;
    fetchReceipt: (receiptId: string) => Promise<{
      id: string;
      payload: Record<string, unknown>;
      status: "pending" | "processed" | "failed";
    } | null>;
    markReceiptProcessed: (receiptId: string, processedAtIso: string) => Promise<void>;
    markReceiptFailed: (receiptId: string, errorMessage: string) => Promise<void>;
    ingestEvent: typeof ingestInboundDmEvent;
    supabaseClient: ReturnType<typeof createSupabaseServiceClient>;
    markDone: (jobId: string) => Promise<void>;
    markFailed: (input: {
      jobId: string;
      attemptCount: number;
      nowIso: string;
      errorMessage: string;
      errorStack?: string;
    }) => Promise<void>;
  }
): Promise<void> {
  try {
    const payload = job.payload as { receiptId?: string } | null;
    const receiptId = payload?.receiptId?.trim();
    if (!receiptId) {
      throw new Error("job payload missing receiptId");
    }

    const receipt = await dependencies.fetchReceipt(receiptId);
    if (!receipt) {
      throw new Error("webhook receipt not found");
    }
    if (receipt.status === "processed") {
      await dependencies.markDone(job.id);
      return;
    }

    const rootPayload = asRecord(receipt.payload);
    const directMessageEvents = Array.isArray(rootPayload?.direct_message_events)
      ? rootPayload.direct_message_events
      : [];
    let ingestedCount = 0;

    for (const rawEvent of directMessageEvents) {
      if (rootPayload && isSelfAuthoredDmEvent(rootPayload, rawEvent)) {
        continue;
      }
      const normalizedPayload = rootPayload
        ? {
            ...rootPayload,
            direct_message_events: [rawEvent]
          }
        : receipt.payload;
      try {
        const event = normalizeXInboundDmEvent(normalizedPayload);
        const result = await dependencies.ingestEvent(dependencies.supabaseClient, event);
        if (result.messageCreated) {
          ingestedCount += 1;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Invalid X DM payload:")
        ) {
          continue;
        }
        throw error;
      }
    }

    const nowIso = dependencies.nowIsoFactory();
    await dependencies.markReceiptProcessed(receiptId, nowIso);
    await dependencies.markDone(job.id);
    dependencies.logger.info(
      JSON.stringify({
        event: "webhook_receipt_processed",
        job_id: job.id,
        receipt_id: receiptId,
        ingested_count: ingestedCount
      })
    );
  } catch (error) {
    const nowIso = dependencies.nowIsoFactory();
    const errorMessage = error instanceof Error ? error.message : "unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;
    const payload = job.payload as { receiptId?: string } | null;
    const receiptId = payload?.receiptId?.trim();

    if (receiptId) {
      await dependencies.markReceiptFailed(receiptId, errorMessage);
    }
    await dependencies.markFailed({
      jobId: job.id,
      attemptCount: job.attempt_count,
      nowIso,
      errorMessage,
      ...(errorStack ? { errorStack } : {})
    });
    dependencies.logger.error(
      JSON.stringify({
        event: "webhook_receipt_processing_failed",
        job_id: job.id,
        ...(receiptId ? { receipt_id: receiptId } : {}),
        error_message: errorMessage
      })
    );
  }
}

export function createWorkerRuntime(dependencies: WorkerDependencies = {}) {
  const config = dependencies.runtimeConfig ?? loadRuntimeConfig();
  const logger = dependencies.logger ?? console;
  const workerId = dependencies.workerId ?? `worker-${randomUUID()}`;
  const staleLockMs = dependencies.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const sleep = dependencies.sleep ?? sleepMs;
  const nowIsoFactory = dependencies.nowIsoFactory ?? (() => new Date().toISOString());

  const supabaseClient = createSupabaseServiceClient(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY
  );
  const claimJob =
    dependencies.claimJob ??
    ((params: { workerId: string; nowIso: string; staleLockMs: number }) =>
      claimNextJob(supabaseClient, params));
  const generateReply =
    dependencies.generateReply ??
    ((messages: OpenRouterChatMessage[], maxReplyChars: number) =>
      generateOpenRouterReply({
        apiKey: config.OPENROUTER_API_KEY,
        model: config.OPENROUTER_MODEL,
        messages,
        maxReplyChars
      }));
  const sendDirectMessage =
    dependencies.sendDirectMessage ??
    ((recipientUserId: string, text: string) =>
      sendXDirectMessage({
        consumerKey: config.X_APP_KEY,
        consumerSecret: config.X_APP_SECRET,
        accessToken: config.X_ACCESS_TOKEN,
        accessSecret: config.X_ACCESS_SECRET,
        recipientUserId,
        text
      }));
  const fetchInboundMessage =
    dependencies.fetchInboundMessage ??
    ((platformMessageId: string) => fetchMessageByPlatformMessageId(supabaseClient, platformMessageId));
  const fetchContext =
    dependencies.fetchContext ??
    ((conversationId: string, maxMessages: number) =>
      fetchConversationContext(supabaseClient, conversationId, maxMessages));
  const insertOutboundMessage =
    dependencies.insertOutboundMessage ??
    (async (input: {
      conversationId: string;
      text: string;
      occurredAtIso: string;
      platformMessageId: string;
    }) => {
      await insertMessage(supabaseClient, {
        conversationId: input.conversationId,
        direction: "outbound",
        text: input.text,
        occurredAtIso: input.occurredAtIso,
        platform: "x",
        platformMessageId: input.platformMessageId
      });
    });
  const fetchOutboundSendAttempt =
    dependencies.fetchOutboundSendAttempt ??
    (async (inboundMessageId: string) => {
      const attempt = await fetchOutboundSendAttemptByInboundMessageId(supabaseClient, inboundMessageId);
      if (!attempt) {
        return null;
      }
      return {
        replyText: attempt.reply_text,
        platformMessageId: attempt.outbound_platform_message_id,
        sentAtIso: attempt.sent_at
      };
    });
  const persistOutboundSendAttempt =
    dependencies.recordOutboundSendAttempt ??
    (async (input: {
      inboundMessageId: string;
      conversationId: string;
      platformUserId: string;
      replyText: string;
      platformMessageId: string;
      sentAtIso: string;
    }) => {
      await recordOutboundSendAttempt(supabaseClient, {
        inboundMessagePlatformId: input.inboundMessageId,
        conversationId: input.conversationId,
        recipientPlatformUserId: input.platformUserId,
        replyText: input.replyText,
        outboundPlatformMessageId: input.platformMessageId,
        sentAtIso: input.sentAtIso,
        platform: "x"
      });
    });
  const markDone = dependencies.markDone ?? ((jobId: string) => markJobDone(supabaseClient, jobId));
  const fetchReceipt = (receiptId: string) => fetchWebhookReceiptById(supabaseClient, receiptId);
  const markReceiptProcessed = (receiptId: string, processedAtIso: string) =>
    markWebhookReceiptProcessed(supabaseClient, receiptId, processedAtIso);
  const markReceiptFailed = (receiptId: string, errorMessage: string) =>
    markWebhookReceiptFailed(supabaseClient, receiptId, errorMessage);
  const updateLastMessageAt =
    dependencies.updateConversationLastMessageAt ??
    ((conversationId: string, occurredAtIso: string) =>
      updateConversationLastMessageAt(supabaseClient, conversationId, occurredAtIso));
  const countInboundMessages =
    dependencies.countInboundMessages ??
    ((conversationId: string) => countConversationInboundMessages(supabaseClient, conversationId));
  const upsertSummary =
    dependencies.upsertSummary ??
    ((conversationId: string, summary: string) =>
      upsertConversationSummary(supabaseClient, conversationId, summary));
  const consumeRateLimitDependency =
    dependencies.consumeRateLimit ??
    ((userId: string, nowIso: string) =>
      consumeRateLimit(supabaseClient, {
        userId,
        scope: OUTBOUND_RATE_LIMIT_SCOPE,
        windowSeconds: OUTBOUND_RATE_LIMIT_WINDOW_SECONDS,
        maxCount: OUTBOUND_RATE_LIMIT_MAX_MESSAGES,
        nowIso
      }));
  const markFailed =
    dependencies.markFailed ??
    ((input: {
      jobId: string;
      attemptCount: number;
      nowIso: string;
      errorMessage: string;
      errorStack?: string;
    }) => {
      const baseInput = {
        jobId: input.jobId,
        attemptCount: input.attemptCount,
        maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
        baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
        nowIso: input.nowIso,
        errorCode: "worker_processing_error",
        errorMessage: input.errorMessage
      };

      return markJobFailed(supabaseClient, {
        ...baseInput,
        ...(input.errorStack ? { errorStack: input.errorStack } : {})
      });
    });
  const processJob =
    dependencies.processJob ??
    ((job: DbJob) => {
      if (job.type === "ingest_webhook_receipt") {
        return processIngestWebhookReceiptJob(job, {
          nowIsoFactory,
          logger,
          fetchReceipt,
          markReceiptProcessed,
          markReceiptFailed,
          ingestEvent: ingestInboundDmEvent,
          supabaseClient,
          markDone,
          markFailed
        });
      }

      return processRespondToInboundDmJob(job, {
        nowIsoFactory,
        maxContextMessages: config.MAX_CONTEXT_MESSAGES,
        maxReplyChars: config.MAX_REPLY_CHARS,
        maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
        retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
        logger,
        fetchInboundMessage,
        fetchContext,
        generateReply,
        sendDirectMessage,
        insertOutboundMessage,
        fetchOutboundSendAttempt,
        recordOutboundSendAttempt: persistOutboundSendAttempt,
        updateConversationLastMessageAt: updateLastMessageAt,
        countInboundMessages,
        upsertSummary,
        consumeRateLimit: consumeRateLimitDependency,
        markDone,
        markFailed
      });
    });
  const requestReplayBackfill =
    dependencies.requestReplayBackfill ??
    (async (window: { fromDateUtcMinute: string; toDateUtcMinute: string }) => {
      if (!config.X_WEBHOOK_ID) {
        return;
      }
      await requestXReplayBackfill({
        appKey: config.X_APP_KEY,
        appSecret: config.X_APP_SECRET,
        webhookId: config.X_WEBHOOK_ID,
        fromDateUtcMinute: window.fromDateUtcMinute,
        toDateUtcMinute: window.toDateUtcMinute
      });
    });
  const botUserId = parseBotUserIdFromAccessToken(config.X_ACCESS_TOKEN);
  const reconcileInboundEvents =
    dependencies.reconcileInboundEvents ??
    (async (params: { cutoffIso: string; sinceId?: string | null }) => {
      if (!botUserId) {
        throw new Error("Unable to parse bot user id from X_ACCESS_TOKEN.");
      }
      const fetched = await fetchReconciliationInboundEvents({
        consumerKey: config.X_APP_KEY,
        consumerSecret: config.X_APP_SECRET,
        accessToken: config.X_ACCESS_TOKEN,
        accessSecret: config.X_ACCESS_SECRET,
        botUserId,
        pageSize: config.DM_RECONCILIATION_PAGE_SIZE,
        cutoffIso: params.cutoffIso,
        ...(params.sinceId ? { sinceId: params.sinceId } : {})
      });

      let ingestedCount = 0;
      for (const event of fetched.events) {
        const ingestResult = await ingestInboundDmEvent(supabaseClient, event);
        if (ingestResult.messageCreated) {
          ingestedCount += 1;
        }
      }
      return {
        ingestedCount,
        highestEventId: fetched.highestEventId
      };
    });

  async function runOnce(): Promise<boolean> {
    const nowIso = nowIsoFactory();
    const nextJob = await claimJob({
      workerId,
      nowIso,
      staleLockMs
    });

    if (!nextJob) {
      return false;
    }

    logger.info(
      JSON.stringify({
        event: "job_claimed",
        job_id: nextJob.id,
        worker_id: workerId
      })
    );

    await processJob(nextJob);
    return true;
  }

  async function runUntilStopped(signal: AbortSignal): Promise<void> {
    let nextHealthLogAtMs = Date.now() + HEALTH_LOG_INTERVAL_MS;
    let nextReplayAtMs = Date.now() + config.X_REPLAY_INTERVAL_MS;
    let nextReconciliationAtMs = Date.now() + config.DM_RECONCILIATION_INTERVAL_MS;
    let latestReconciliationSinceId: string | null = null;
    while (!signal.aborted) {
      const didWork = await runOnce();
      const nowMs = Date.now();
      if (nowMs >= nextHealthLogAtMs) {
        logger.info(
          JSON.stringify({
            event: "worker_heartbeat",
            worker_id: workerId,
            poll_interval_ms: config.WORKER_POLL_INTERVAL_MS
          })
        );
        nextHealthLogAtMs = nowMs + HEALTH_LOG_INTERVAL_MS;
      }
      if (config.ENABLE_X_REPLAY_BACKFILL && nowMs >= nextReplayAtMs) {
        const replayWindow = computeReplayWindow(new Date(nowMs), config.X_REPLAY_WINDOW_MINUTES);
        try {
          await requestReplayBackfill(replayWindow);
          logger.info(
            JSON.stringify({
              event: "replay_backfill_requested",
              worker_id: workerId,
              from_date: replayWindow.fromDateUtcMinute,
              to_date: replayWindow.toDateUtcMinute
            })
          );
        } catch (error) {
          logger.error(
            JSON.stringify({
              event: "replay_backfill_request_failed",
              worker_id: workerId,
              error_message: error instanceof Error ? error.message : "unknown replay error"
            })
          );
        }
        nextReplayAtMs = nowMs + config.X_REPLAY_INTERVAL_MS;
      }
      if (config.ENABLE_DM_RECONCILIATION && nowMs >= nextReconciliationAtMs) {
        const cutoffIso = new Date(
          nowMs - config.DM_RECONCILIATION_LOOKBACK_MINUTES * 60_000
        ).toISOString();
        try {
          const reconciliationResult = await reconcileInboundEvents({
            cutoffIso,
            ...(latestReconciliationSinceId ? { sinceId: latestReconciliationSinceId } : {})
          });
          if (reconciliationResult.highestEventId) {
            latestReconciliationSinceId = reconciliationResult.highestEventId;
          }
          logger.info(
            JSON.stringify({
              event: "dm_reconciliation_completed",
              worker_id: workerId,
              ingested_count: reconciliationResult.ingestedCount,
              since_id: latestReconciliationSinceId
            })
          );
        } catch (error) {
          logger.error(
            JSON.stringify({
              event: "dm_reconciliation_failed",
              worker_id: workerId,
              error_message: error instanceof Error ? error.message : "unknown reconciliation error"
            })
          );
        }
        nextReconciliationAtMs = nowMs + config.DM_RECONCILIATION_INTERVAL_MS;
      }
      if (!didWork) {
        await sleep(config.WORKER_POLL_INTERVAL_MS);
      }
    }
  }

  return {
    name: "worker-vps",
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
    workerId,
    runOnce,
    runUntilStopped
  };
}
