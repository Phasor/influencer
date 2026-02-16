import type { ConversationContext, DbJob, DbMessage, RuntimeConfig } from "@ai-influencer/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRecentConversationMessages,
  createWorkerRuntime,
  processRespondToInboundDmJob
} from "./index";

const runtimeConfig: RuntimeConfig = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  OPENROUTER_API_KEY: "openrouter-key",
  OPENROUTER_MODEL: "test-model",
  X_APP_KEY: "x-app-key",
  X_APP_SECRET: "x-app-secret",
  X_ACCESS_TOKEN: "x-access-token",
  X_ACCESS_SECRET: "x-access-secret",
  X_WEBHOOK_SECRET: "x-webhook-secret",
  X_WEBHOOK_ID: null,
  WORKER_POLL_INTERVAL_MS: 25,
  MAX_CONTEXT_MESSAGES: 20,
  MAX_REPLY_CHARS: 500,
  ENABLE_X_REPLAY_BACKFILL: false,
  X_REPLAY_INTERVAL_MS: 300000,
  X_REPLAY_WINDOW_MINUTES: 120
};

describe("buildRecentConversationMessages", () => {
  it("keeps order and maps direction to OpenRouter roles", () => {
    const recentMessages = [
      { direction: "inbound", text_content: "hi" },
      { direction: "outbound", text_content: "hello" },
      { direction: "inbound", text_content: "how are you?" }
    ] as DbMessage[];

    const result = buildRecentConversationMessages(recentMessages, 2);

    expect(result).toEqual([
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you?" }
    ]);
  });

  it("rejects invalid maxMessages", () => {
    expect(() => buildRecentConversationMessages([] as DbMessage[], 0)).toThrow("maxMessages");
  });
});

describe("createWorkerRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runOnce claims and processes one job", async () => {
    const claimJob = vi.fn(async () => ({ id: "job-1" } as DbJob));
    const processJob = vi.fn(async () => {});

    const runtime = createWorkerRuntime({
      runtimeConfig,
      workerId: "worker-test",
      nowIsoFactory: () => "2026-02-11T00:00:00.000Z",
      claimJob,
      processJob
    });

    await expect(runtime.runOnce()).resolves.toBe(true);
    expect(claimJob).toHaveBeenCalledWith({
      workerId: "worker-test",
      nowIso: "2026-02-11T00:00:00.000Z",
      staleLockMs: 60000
    });
    expect(processJob).toHaveBeenCalledTimes(1);
  });

  it("runOnce returns false when no claimable jobs exist", async () => {
    const claimJob = vi.fn(async () => null);
    const processJob = vi.fn(async () => {});

    const runtime = createWorkerRuntime({
      runtimeConfig,
      workerId: "worker-test",
      claimJob,
      processJob
    });

    await expect(runtime.runOnce()).resolves.toBe(false);
    expect(processJob).not.toHaveBeenCalled();
  });

  it("runUntilStopped sleeps when queue is empty", async () => {
    const claimJob = vi.fn(async () => null);
    const sleep = vi.fn(async () => {});
    const runtime = createWorkerRuntime({
      runtimeConfig,
      workerId: "worker-test",
      claimJob,
      sleep
    });

    const controller = new AbortController();
    sleep.mockImplementationOnce(async () => {
      controller.abort();
    });

    await runtime.runUntilStopped(controller.signal);
    expect(sleep).toHaveBeenCalledWith(runtimeConfig.WORKER_POLL_INTERVAL_MS);
  });

  it("runUntilStopped triggers replay requests when enabled", async () => {
    const claimJob = vi.fn(async () => null);
    const sleep = vi.fn(async () => {});
    const requestReplayBackfill = vi.fn(async () => {});
    const replayConfig: RuntimeConfig = {
      ...runtimeConfig,
      ENABLE_X_REPLAY_BACKFILL: true,
      X_WEBHOOK_ID: "webhook-123",
      X_REPLAY_INTERVAL_MS: -1
    };
    const runtime = createWorkerRuntime({
      runtimeConfig: replayConfig,
      workerId: "worker-test",
      claimJob,
      sleep,
      requestReplayBackfill
    });

    const controller = new AbortController();
    sleep.mockImplementationOnce(async () => {
      controller.abort();
    });

    await runtime.runUntilStopped(controller.signal);
    expect(requestReplayBackfill).toHaveBeenCalledTimes(1);
  });

  it("runOnce executes the default job pipeline with mocked integrations", async () => {
    const claimJob = vi.fn(
      async () =>
        ({
          id: "job-22",
          attempt_count: 1,
          payload: {
            inboundMessageId: "in-22",
            platformUserId: "user-22"
          }
        }) as unknown as DbJob
    );
    const fetchInboundMessage = vi.fn(
      async () =>
        ({
          conversation_id: "conv-22",
          text_content: "yo"
        }) as DbMessage
    );
    const fetchContext = vi.fn(
      async () =>
        ({
          conversation: { user_id: "db-user-22" },
          recentMessages: [{ direction: "inbound", text_content: "yo" }]
        }) as unknown as ConversationContext
    );
    const generateReply = vi.fn(async () => "hello from worker");
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-22" }));
    const insertOutboundMessage = vi.fn(async () => {});
    const fetchOutboundSendAttempt = vi.fn(async () => null);
    const recordOutboundSendAttempt = vi.fn(async () => {});
    const updateConversationLastMessageAt = vi.fn(async () => {});
    const countInboundMessages = vi.fn(async () => 9);
    const upsertSummary = vi.fn(async () => {});
    const consumeRateLimit = vi.fn(async () => ({ allowed: true, count: 1 }));
    const markDone = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    const runtime = createWorkerRuntime({
      runtimeConfig,
      workerId: "worker-test",
      nowIsoFactory: () => "2026-02-11T00:00:00.000Z",
      claimJob,
      fetchInboundMessage,
      fetchContext,
      generateReply,
      sendDirectMessage,
      insertOutboundMessage,
      fetchOutboundSendAttempt,
      recordOutboundSendAttempt,
      updateConversationLastMessageAt,
      countInboundMessages,
      upsertSummary,
      consumeRateLimit,
      markDone,
      markFailed
    });

    await expect(runtime.runOnce()).resolves.toBe(true);
    expect(sendDirectMessage).toHaveBeenCalledWith("user-22", "hello from worker");
    expect(insertOutboundMessage).toHaveBeenCalledWith({
      conversationId: "conv-22",
      text: "hello from worker",
      occurredAtIso: "2026-02-11T00:00:00.000Z",
      platformMessageId: "out-22"
    });
    expect(updateConversationLastMessageAt).toHaveBeenCalledWith(
      "conv-22",
      "2026-02-11T00:00:00.000Z"
    );
    expect(markDone).toHaveBeenCalledWith("job-22");
    expect(markFailed).not.toHaveBeenCalled();
    expect(recordOutboundSendAttempt).toHaveBeenCalledWith({
      inboundMessageId: "in-22",
      conversationId: "conv-22",
      platformUserId: "user-22",
      replyText: "hello from worker",
      platformMessageId: "out-22",
      sentAtIso: "2026-02-11T00:00:00.000Z"
    });
  });
});

describe("processRespondToInboundDmJob", () => {
  it("completes job after generating and sending outbound reply", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const fetchInboundMessage = vi.fn(
      async () =>
        ({
          conversation_id: "conv-1",
          text_content: "hi there"
        }) as DbMessage
    );
    const fetchContext = vi.fn(
      async () =>
        ({
          conversation: { user_id: "db-user-1" },
          recentMessages: [
            { direction: "inbound", text_content: "hi there" },
            { direction: "outbound", text_content: "hello" }
          ]
        }) as unknown as ConversationContext
    );
    const generateReply = vi.fn(async () => "thanks for messaging me");
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-1" }));
    const insertOutboundMessage = vi.fn(async () => {});
    const fetchOutboundSendAttempt = vi.fn(async () => null);
    const recordOutboundSendAttempt = vi.fn(async () => {});
    const updateConversationLastMessageAt = vi.fn(async () => {});
    const countInboundMessages = vi.fn(async () => 9);
    const upsertSummary = vi.fn(async () => {});
    const consumeRateLimit = vi.fn(async () => ({ allowed: true, count: 1 }));
    const markDone = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processRespondToInboundDmJob(
      {
        id: "job-1",
        attempt_count: 1,
        payload: {
          inboundMessageId: "in-1",
          platformUserId: "user-1"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:00:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
        fetchInboundMessage,
        fetchContext,
        generateReply,
        sendDirectMessage,
        insertOutboundMessage,
        fetchOutboundSendAttempt,
        recordOutboundSendAttempt,
        updateConversationLastMessageAt,
        countInboundMessages,
        upsertSummary,
        consumeRateLimit,
        markDone,
        markFailed
      }
    );

    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledWith("user-1", "thanks for messaging me");
    expect(insertOutboundMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      text: "thanks for messaging me",
      occurredAtIso: "2026-02-11T00:00:00.000Z",
      platformMessageId: "out-1"
    });
    expect(markDone).toHaveBeenCalledWith("job-1");
    expect(markFailed).not.toHaveBeenCalled();
    expect(updateConversationLastMessageAt).toHaveBeenCalledWith(
      "conv-1",
      "2026-02-11T00:00:00.000Z"
    );
    expect(recordOutboundSendAttempt).toHaveBeenCalledWith({
      inboundMessageId: "in-1",
      conversationId: "conv-1",
      platformUserId: "user-1",
      replyText: "thanks for messaging me",
      platformMessageId: "out-1",
      sentAtIso: "2026-02-11T00:00:00.000Z"
    });
    expect(upsertSummary).not.toHaveBeenCalled();
  });

  it("marks job failed when processing errors", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const markFailed = vi.fn(async () => {});

    await processRespondToInboundDmJob(
      {
        id: "job-2",
        attempt_count: 2,
        payload: {
          inboundMessageId: "in-2",
          platformUserId: "user-2"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:01:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
        fetchInboundMessage: vi.fn(async () => null),
        fetchContext: vi.fn(
          async () =>
            ({
              recentMessages: []
            }) as unknown as ConversationContext
        ),
        generateReply: vi.fn(async () => "unused"),
        sendDirectMessage: vi.fn(async () => ({ platformMessageId: "unused" })),
        insertOutboundMessage: vi.fn(async () => {}),
        fetchOutboundSendAttempt: vi.fn(async () => null),
        recordOutboundSendAttempt: vi.fn(async () => {}),
        updateConversationLastMessageAt: vi.fn(async () => {}),
        countInboundMessages: vi.fn(async () => 0),
        upsertSummary: vi.fn(async () => {}),
        consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
        markDone: vi.fn(async () => {}),
        markFailed
      }
    );

    expect(markFailed).toHaveBeenCalledWith({
      jobId: "job-2",
      attemptCount: 2,
      nowIso: "2026-02-11T00:01:00.000Z",
      errorMessage: "inbound message not found for job payload",
      errorStack: expect.any(String)
    });
  });

  it("does not re-send when an outbound send attempt already exists", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-should-not-send" }));
    const generateReply = vi.fn(async () => "should not generate");
    const markDone = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});

    await processRespondToInboundDmJob(
      {
        id: "job-3",
        attempt_count: 2,
        payload: {
          inboundMessageId: "in-3",
          platformUserId: "user-3"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:02:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
      fetchInboundMessage: vi.fn(
        async () =>
          ({
            conversation_id: "conv-3",
            text_content: "normal message"
          }) as DbMessage
      ),
        fetchContext: vi.fn(
          async () =>
            ({
              recentMessages: []
            }) as unknown as ConversationContext
        ),
        generateReply,
        sendDirectMessage,
        fetchOutboundSendAttempt: vi.fn(async () => ({
          replyText: "already sent",
          platformMessageId: "out-3",
          sentAtIso: "2026-02-11T00:01:30.000Z"
        })),
        recordOutboundSendAttempt: vi.fn(async () => {}),
        insertOutboundMessage: vi.fn(async () => {}),
        updateConversationLastMessageAt: vi.fn(async () => {}),
        countInboundMessages: vi.fn(async () => 3),
        upsertSummary: vi.fn(async () => {}),
        consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
        markDone,
        markFailed
      }
    );

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith("job-3");
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("avoids duplicate sends after prior send succeeded but message insert failed", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const markFailedFirstRun = vi.fn(async () => {});
    const markDoneSecondRun = vi.fn(async () => {});
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-4" }));
    const recordOutboundSendAttempt = vi.fn(async () => {});
    const attemptState = {
      replyText: "persist me",
      platformMessageId: "out-4",
      sentAtIso: "2026-02-11T00:03:00.000Z"
    };
    const fetchOutboundSendAttempt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(attemptState);
    const insertOutboundMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("insertMessage failed: transient db error"))
      .mockResolvedValueOnce(undefined);

    const job = {
      id: "job-4",
      attempt_count: 1,
      payload: {
        inboundMessageId: "in-4",
        platformUserId: "user-4"
      }
    } as unknown as DbJob;

    await processRespondToInboundDmJob(job, {
      nowIsoFactory: () => "2026-02-11T00:03:00.000Z",
      maxContextMessages: 20,
      maxReplyChars: 500,
      maxAttempts: 5,
      retryBaseDelayMs: 1000,
      logger,
      fetchInboundMessage: vi.fn(
        async () =>
          ({
            conversation_id: "conv-4",
            text_content: "hi"
          }) as DbMessage
      ),
      fetchContext: vi.fn(
        async () =>
          ({
            conversation: { user_id: "db-user-4" },
            recentMessages: [{ direction: "inbound", text_content: "hi" }]
          }) as unknown as ConversationContext
      ),
      generateReply: vi.fn(async () => "persist me"),
      sendDirectMessage,
      fetchOutboundSendAttempt,
      recordOutboundSendAttempt,
      insertOutboundMessage,
      updateConversationLastMessageAt: vi.fn(async () => {}),
      countInboundMessages: vi.fn(async () => 4),
      upsertSummary: vi.fn(async () => {}),
      consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
      markDone: vi.fn(async () => {}),
      markFailed: markFailedFirstRun
    });

    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(recordOutboundSendAttempt).toHaveBeenCalledTimes(1);
    expect(markFailedFirstRun).toHaveBeenCalledTimes(1);

    await processRespondToInboundDmJob(job, {
      nowIsoFactory: () => "2026-02-11T00:03:10.000Z",
      maxContextMessages: 20,
      maxReplyChars: 500,
      maxAttempts: 5,
      retryBaseDelayMs: 1000,
      logger,
      fetchInboundMessage: vi.fn(
        async () =>
          ({
            conversation_id: "conv-4",
            text_content: "hi"
          }) as DbMessage
      ),
      fetchContext: vi.fn(
        async () =>
          ({
            conversation: { user_id: "db-user-4" },
            recentMessages: [{ direction: "inbound", text_content: "hi" }]
          }) as unknown as ConversationContext
      ),
      generateReply: vi.fn(async () => "persist me"),
      sendDirectMessage,
      fetchOutboundSendAttempt,
      recordOutboundSendAttempt,
      insertOutboundMessage,
      updateConversationLastMessageAt: vi.fn(async () => {}),
      countInboundMessages: vi.fn(async () => 4),
      upsertSummary: vi.fn(async () => {}),
      consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
      markDone: markDoneSecondRun,
      markFailed: vi.fn(async () => {})
    });

    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(markDoneSecondRun).toHaveBeenCalledTimes(1);
  });

  it("refreshes summary every configured inbound interval", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const upsertSummary = vi.fn(async () => {});
    const generateReply = vi.fn(async () => "short reply");

    await processRespondToInboundDmJob(
      {
        id: "job-5",
        attempt_count: 1,
        payload: {
          inboundMessageId: "in-5",
          platformUserId: "user-5"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:04:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
        fetchInboundMessage: vi.fn(
          async () =>
            ({
              conversation_id: "conv-5",
              text_content: "hello there"
            }) as DbMessage
        ),
        fetchContext: vi.fn(
          async () =>
            ({
              conversation: { user_id: "db-user-5" },
              summary: "x".repeat(2_000),
              recentMessages: [{ direction: "inbound", text_content: "hello there" }]
            }) as unknown as ConversationContext
        ),
        generateReply,
        sendDirectMessage: vi.fn(async () => ({ platformMessageId: "out-5" })),
        fetchOutboundSendAttempt: vi.fn(async () => null),
        recordOutboundSendAttempt: vi.fn(async () => {}),
        insertOutboundMessage: vi.fn(async () => {}),
        updateConversationLastMessageAt: vi.fn(async () => {}),
        countInboundMessages: vi.fn(async () => 10),
        upsertSummary,
        consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
        markDone: vi.fn(async () => {}),
        markFailed: vi.fn(async () => {})
      }
    );

    const firstCallArgs = generateReply.mock.calls[0] as unknown as [Array<{ content: string }>];
    const promptMessages = firstCallArgs[0];
    expect(promptMessages[1]?.content.startsWith("Conversation summary:")).toBe(true);
    expect(promptMessages[1]?.content.length).toBeLessThanOrEqual(1_223);
    expect(upsertSummary).toHaveBeenCalledTimes(1);
    const firstSummaryCall = upsertSummary.mock.calls[0] as unknown as [string, string];
    expect(firstSummaryCall[1].length).toBeLessThanOrEqual(1_200);
  });

  it("uses slowdown reply and skips LLM when rate limit is exceeded", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const generateReply = vi.fn(async () => "should not be used");
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-6" }));

    await processRespondToInboundDmJob(
      {
        id: "job-6",
        attempt_count: 1,
        payload: {
          inboundMessageId: "in-6",
          platformUserId: "user-6"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:05:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
        fetchInboundMessage: vi.fn(
          async () =>
            ({
              conversation_id: "conv-6",
              text_content: "hello"
            }) as DbMessage
        ),
        fetchContext: vi.fn(
          async () =>
            ({
              conversation: { user_id: "db-user-6" },
              recentMessages: []
            }) as unknown as ConversationContext
        ),
        generateReply,
        sendDirectMessage,
        fetchOutboundSendAttempt: vi.fn(async () => null),
        recordOutboundSendAttempt: vi.fn(async () => {}),
        insertOutboundMessage: vi.fn(async () => {}),
        updateConversationLastMessageAt: vi.fn(async () => {}),
        countInboundMessages: vi.fn(async () => 1),
        upsertSummary: vi.fn(async () => {}),
        consumeRateLimit: vi.fn(async () => ({ allowed: false, count: 6 })),
        markDone: vi.fn(async () => {}),
        markFailed: vi.fn(async () => {})
      }
    );

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledWith(
      "user-6",
      "You are messaging fast right now - please slow down and try again in a minute."
    );
  });

  it("uses moderation refusal and skips LLM for unsafe input", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };
    const generateReply = vi.fn(async () => "should not be used");
    const sendDirectMessage = vi.fn(async () => ({ platformMessageId: "out-7" }));

    await processRespondToInboundDmJob(
      {
        id: "job-7",
        attempt_count: 1,
        payload: {
          inboundMessageId: "in-7",
          platformUserId: "user-7"
        }
      } as unknown as DbJob,
      {
        nowIsoFactory: () => "2026-02-11T00:06:00.000Z",
        maxContextMessages: 20,
        maxReplyChars: 500,
        maxAttempts: 5,
        retryBaseDelayMs: 1000,
        logger,
        fetchInboundMessage: vi.fn(
          async () =>
            ({
              conversation_id: "conv-7",
              text_content: "how to make a bomb"
            }) as DbMessage
        ),
        fetchContext: vi.fn(
          async () =>
            ({
              conversation: { user_id: "db-user-7" },
              recentMessages: []
            }) as unknown as ConversationContext
        ),
        generateReply,
        sendDirectMessage,
        fetchOutboundSendAttempt: vi.fn(async () => null),
        recordOutboundSendAttempt: vi.fn(async () => {}),
        insertOutboundMessage: vi.fn(async () => {}),
        updateConversationLastMessageAt: vi.fn(async () => {}),
        countInboundMessages: vi.fn(async () => 1),
        upsertSummary: vi.fn(async () => {}),
        consumeRateLimit: vi.fn(async () => ({ allowed: true, count: 1 })),
        markDone: vi.fn(async () => {}),
        markFailed: vi.fn(async () => {})
      }
    );

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledWith(
      "user-7",
      "I can't help with that. Let's keep things safe and respectful."
    );
  });
});
