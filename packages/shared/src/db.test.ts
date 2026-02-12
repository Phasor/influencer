import { describe, expect, it, vi } from "vitest";

import {
  claimNextJob,
  consumeRateLimit,
  computeStaleLockCutoffIso,
  computeJobFailureTransition,
  computeRetryDelayMs,
  dedupeKeyForInboundMessage,
  markJobDone,
  markJobFailed,
  recordOutboundSendAttempt
} from "./db";

describe("dedupeKeyForInboundMessage", () => {
  it("creates stable dedupe keys for inbound X DMs", () => {
    expect(dedupeKeyForInboundMessage("12345")).toBe("x_dm_inbound:12345");
  });
});

describe("computeRetryDelayMs", () => {
  it("uses exponential backoff with base delay", () => {
    expect(computeRetryDelayMs(1, 1000)).toBe(1000);
    expect(computeRetryDelayMs(2, 1000)).toBe(2000);
    expect(computeRetryDelayMs(3, 1000)).toBe(4000);
  });

  it("rejects invalid inputs", () => {
    expect(() => computeRetryDelayMs(0, 1000)).toThrow("attemptCount");
    expect(() => computeRetryDelayMs(1, 0)).toThrow("baseDelayMs");
  });
});

describe("computeJobFailureTransition", () => {
  it("requeues when attempts are below max", () => {
    const now = new Date("2026-02-11T00:00:00.000Z");
    const result = computeJobFailureTransition({
      attemptCount: 2,
      maxAttempts: 5,
      baseDelayMs: 1000,
      now
    });

    expect(result.nextStatus).toBe("queued");
    expect(result.nextRunAfterIso).toBe("2026-02-11T00:00:02.000Z");
  });

  it("marks failed when max attempts reached", () => {
    const now = new Date("2026-02-11T00:00:00.000Z");
    const result = computeJobFailureTransition({
      attemptCount: 5,
      maxAttempts: 5,
      baseDelayMs: 1000,
      now
    });

    expect(result.nextStatus).toBe("failed");
    expect(result.nextRunAfterIso).toBeNull();
  });
});

describe("computeStaleLockCutoffIso", () => {
  it("subtracts stale lock duration from now timestamp", () => {
    const cutoff = computeStaleLockCutoffIso("2026-02-11T00:00:10.000Z", 5000);
    expect(cutoff).toBe("2026-02-11T00:00:05.000Z");
  });

  it("rejects non-positive stale lock duration", () => {
    expect(() => computeStaleLockCutoffIso("2026-02-11T00:00:10.000Z", 0)).toThrow("staleLockMs");
  });
});

function createSelectChain(result: { data: unknown; error: { message: string } | null }) {
  const chain: {
    eq: ReturnType<typeof vi.fn>;
    lte: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    data?: unknown;
    error?: { message: string } | null;
  } = {
    eq: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(async () => result),
    data: null,
    error: null
  };

  chain.eq.mockReturnValue(chain);
  chain.lte.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);

  return chain;
}

function createUpdateChain(result: { data: unknown; error: { message: string } | null }) {
  const chain: {
    eq: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    data?: unknown;
    error?: { message: string } | null;
  } = {
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn(async () => result),
    data: null,
    error: null
  };

  chain.eq.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);

  return chain;
}

describe("claimNextJob", () => {
  it("claims queued jobs by transitioning to processing and incrementing attempt_count", async () => {
    const queuedJob = {
      id: "job-1",
      status: "queued",
      attempt_count: 0
    };
    const claimedJob = {
      id: "job-1",
      status: "processing",
      attempt_count: 1
    };
    const queuedSelectChain = createSelectChain({
      data: queuedJob,
      error: null
    });
    const updateChain = createUpdateChain({
      data: claimedJob,
      error: null
    });
    const updatePayloads: Array<Record<string, unknown>> = [];

    const from = vi
      .fn()
      .mockImplementationOnce(() => ({
        select: vi.fn(() => queuedSelectChain)
      }))
      .mockImplementationOnce(() => ({
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          return updateChain;
        })
      }));

    const client = {
      from
    };

    const result = await claimNextJob(client as never, {
      workerId: "worker-a",
      nowIso: "2026-02-11T00:00:00.000Z"
    });

    expect(result).toEqual(claimedJob);
    expect(updatePayloads[0]).toMatchObject({
      status: "processing",
      locked_at: "2026-02-11T00:00:00.000Z",
      locked_by: "worker-a",
      last_attempt_at: "2026-02-11T00:00:00.000Z",
      attempt_count: 1
    });
    expect(updateChain.eq).toHaveBeenCalledWith("id", "job-1");
    expect(updateChain.eq).toHaveBeenCalledWith("status", "queued");
  });

  it("reclaims stale processing jobs when queue is empty", async () => {
    const staleJob = {
      id: "job-stale",
      status: "processing",
      attempt_count: 2,
      locked_at: "2026-02-11T00:00:00.000Z"
    };
    const reclaimedJob = {
      id: "job-stale",
      status: "processing",
      attempt_count: 3
    };
    const queuedSelectChain = createSelectChain({
      data: null,
      error: null
    });
    const staleSelectChain = createSelectChain({
      data: staleJob,
      error: null
    });
    const reclaimUpdateChain = createUpdateChain({
      data: reclaimedJob,
      error: null
    });
    const updatePayloads: Array<Record<string, unknown>> = [];

    const from = vi
      .fn()
      .mockImplementationOnce(() => ({
        select: vi.fn(() => queuedSelectChain)
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn(() => staleSelectChain)
      }))
      .mockImplementationOnce(() => ({
        update: vi.fn((payload: Record<string, unknown>) => {
          updatePayloads.push(payload);
          return reclaimUpdateChain;
        })
      }));

    const client = {
      from
    };

    const result = await claimNextJob(client as never, {
      workerId: "worker-b",
      nowIso: "2026-02-11T00:01:00.000Z",
      staleLockMs: 30_000
    });

    expect(result).toEqual(reclaimedJob);
    expect(updatePayloads[0]).toMatchObject({
      status: "processing",
      locked_at: "2026-02-11T00:01:00.000Z",
      locked_by: "worker-b",
      last_attempt_at: "2026-02-11T00:01:00.000Z",
      attempt_count: 3
    });
    expect(reclaimUpdateChain.eq).toHaveBeenCalledWith("id", "job-stale");
    expect(reclaimUpdateChain.eq).toHaveBeenCalledWith("status", "processing");
    expect(reclaimUpdateChain.eq).toHaveBeenCalledWith(
      "locked_at",
      "2026-02-11T00:00:00.000Z"
    );
  });
});

describe("markJobDone", () => {
  it("transitions processing jobs to done and clears lock + error fields", async () => {
    const updatePayloads: Array<Record<string, unknown>> = [];
    const updateChain = {
      eq: vi.fn(),
      error: null
    };
    updateChain.eq.mockReturnValue(updateChain);

    const from = vi.fn().mockImplementationOnce(() => ({
      update: vi.fn((payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        return updateChain;
      })
    }));
    const client = { from };

    await markJobDone(client as never, "job-9");

    expect(updatePayloads[0]).toEqual({
      status: "done",
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_message: null,
      error_stack: null
    });
    expect(updateChain.eq).toHaveBeenCalledWith("id", "job-9");
    expect(updateChain.eq).toHaveBeenCalledWith("status", "processing");
  });
});

describe("recordOutboundSendAttempt", () => {
  it("creates a new outbound send attempt row", async () => {
    const inserted = {
      id: "attempt-1",
      inbound_message_platform_id: "in-1",
      outbound_platform_message_id: "out-1"
    };
    const upsertChain = {
      select: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: inserted, error: null }))
    };
    upsertChain.select.mockReturnValue(upsertChain);

    const from = vi.fn().mockImplementationOnce(() => ({
      upsert: vi.fn(() => upsertChain)
    }));
    const client = { from };

    const result = await recordOutboundSendAttempt(client as never, {
      inboundMessagePlatformId: "in-1",
      conversationId: "conv-1",
      recipientPlatformUserId: "user-1",
      replyText: "hello",
      outboundPlatformMessageId: "out-1",
      sentAtIso: "2026-02-11T00:00:00.000Z"
    });

    expect(result.created).toBe(true);
    expect(result.attempt).toEqual(inserted);
  });

  it("returns existing attempt when duplicate is ignored", async () => {
    const existing = {
      id: "attempt-existing",
      inbound_message_platform_id: "in-2",
      outbound_platform_message_id: "out-2"
    };
    const upsertChain = {
      select: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null }))
    };
    upsertChain.select.mockReturnValue(upsertChain);

    const selectChain = {
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: existing, error: null }))
    };
    selectChain.eq.mockReturnValue(selectChain);

    const from = vi
      .fn()
      .mockImplementationOnce(() => ({
        upsert: vi.fn(() => upsertChain)
      }))
      .mockImplementationOnce(() => ({
        select: vi.fn(() => selectChain)
      }));
    const client = { from };

    const result = await recordOutboundSendAttempt(client as never, {
      inboundMessagePlatformId: "in-2",
      conversationId: "conv-1",
      recipientPlatformUserId: "user-1",
      replyText: "hello",
      outboundPlatformMessageId: "out-2",
      sentAtIso: "2026-02-11T00:00:00.000Z"
    });

    expect(result.created).toBe(false);
    expect(result.attempt).toEqual(existing);
  });
});

describe("consumeRateLimit", () => {
  it("creates a new window counter and allows first request", async () => {
    const selectChain = {
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null }))
    };
    selectChain.eq.mockReturnValue(selectChain);
    const insertChain = {
      select: vi.fn(),
      single: vi.fn(async () => ({ data: { request_count: 1 }, error: null }))
    };
    insertChain.select.mockReturnValue(insertChain);

    const from = vi
      .fn()
      .mockImplementationOnce(() => ({
        select: vi.fn(() => selectChain)
      }))
      .mockImplementationOnce(() => ({
        insert: vi.fn(() => insertChain)
      }));

    const result = await consumeRateLimit({ from } as never, {
      userId: "user-1",
      scope: "scope-a",
      windowSeconds: 60,
      maxCount: 2,
      nowIso: "2026-02-11T00:00:30.000Z"
    });

    expect(result).toEqual({
      allowed: true,
      count: 1,
      windowStartIso: "2026-02-11T00:00:00.000Z"
    });
  });

  it("increments existing counter and blocks when over limit", async () => {
    const selectChain = {
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { id: "rl-1", request_count: 2 }, error: null }))
    };
    selectChain.eq.mockReturnValue(selectChain);

    const updateChain = {
      eq: vi.fn(),
      select: vi.fn(),
      single: vi.fn(async () => ({ data: { request_count: 3 }, error: null }))
    };
    updateChain.eq.mockReturnValue(updateChain);
    updateChain.select.mockReturnValue(updateChain);

    const from = vi
      .fn()
      .mockImplementationOnce(() => ({
        select: vi.fn(() => selectChain)
      }))
      .mockImplementationOnce(() => ({
        update: vi.fn(() => updateChain)
      }));

    const result = await consumeRateLimit({ from } as never, {
      userId: "user-1",
      scope: "scope-a",
      windowSeconds: 60,
      maxCount: 2,
      nowIso: "2026-02-11T00:00:35.000Z"
    });

    expect(result.allowed).toBe(false);
    expect(result.count).toBe(3);
  });
});

describe("markJobFailed", () => {
  it("keeps run_after non-null when transitioning to failed", async () => {
    const updatePayloads: Array<Record<string, unknown>> = [];
    const updateChain = {
      eq: vi.fn(),
      error: null
    };
    updateChain.eq.mockReturnValue(updateChain);

    const from = vi.fn().mockImplementationOnce(() => ({
      update: vi.fn((payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        return updateChain;
      })
    }));

    await markJobFailed({ from } as never, {
      jobId: "job-failed-1",
      attemptCount: 5,
      maxAttempts: 5,
      baseDelayMs: 1000,
      nowIso: "2026-02-12T12:00:00.000Z",
      errorCode: "worker_processing_error",
      errorMessage: "boom"
    });

    expect(updatePayloads[0]).toMatchObject({
      status: "failed",
      run_after: "2026-02-12T12:00:00.000Z"
    });
  });
});
