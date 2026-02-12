import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestInboundDmEvent } from "./ingest";
import type { DbConversation, DbJob, DbMessage } from "./types";

vi.mock("./db", () => {
  return {
    dedupeKeyForInboundMessage: vi.fn((platformMessageId: string) => `x_dm_inbound:${platformMessageId}`),
    enqueueJob: vi.fn(),
    getOrCreateConversation: vi.fn(),
    insertMessage: vi.fn()
  };
});

import { enqueueJob, getOrCreateConversation, insertMessage } from "./db";

type MockConversationRow = { error: { message: string } | null };
type MockMessageRow = {
  error: { message: string } | null;
  data: { id: string; conversation_id: string } | null;
};

function createMockSupabaseClient(options?: {
  conversationUpdateError?: string;
  existingMessageData?: { id: string; conversation_id: string } | null;
}): SupabaseClient {
  const conversationUpdateError = options?.conversationUpdateError ?? null;
  const existingMessageData = options?.existingMessageData ?? {
    id: "existing-msg",
    conversation_id: "conv-existing"
  };

  const messagesQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn()
  };
  messagesQuery.select.mockReturnValue(messagesQuery);
  messagesQuery.eq.mockReturnValue(messagesQuery);
  messagesQuery.single.mockResolvedValue({
    error: null,
    data: existingMessageData
  } as MockMessageRow);

  const conversationsUpdate = {
    eq: vi.fn()
  };
  conversationsUpdate.eq.mockResolvedValue({
    error: conversationUpdateError ? { message: conversationUpdateError } : null
  } as MockConversationRow);

  const conversationsQuery = {
    update: vi.fn()
  };
  conversationsQuery.update.mockReturnValue(conversationsUpdate);

  const from = vi.fn((table: string) => {
    if (table === "messages") {
      return messagesQuery;
    }
    if (table === "conversations") {
      return conversationsQuery;
    }
    throw new Error(`Unexpected table requested in test mock: ${table}`);
  });

  return {
    from
  } as unknown as SupabaseClient;
}

describe("ingestInboundDmEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates inbound message and enqueues a job on first delivery", async () => {
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      id: "conv-1"
    } as DbConversation);
    vi.mocked(insertMessage).mockResolvedValue({
      id: "msg-1"
    } as DbMessage);
    vi.mocked(enqueueJob).mockResolvedValue({
      job: { id: "job-1" } as DbJob,
      created: true
    });

    const client = createMockSupabaseClient();

    const result = await ingestInboundDmEvent(client, {
      platform: "x",
      platformMessageId: "pm-1",
      platformUserId: "user-1",
      platformUserHandle: "handle-1",
      receivedAtIso: "2026-02-11T00:00:00.000Z",
      text: "hello"
    });

    expect(result).toEqual({
      conversationId: "conv-1",
      messageId: "msg-1",
      jobId: "job-1",
      messageCreated: true,
      jobCreated: true
    });
  });

  it("treats duplicate inbound message as replay-safe and does not fail", async () => {
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      id: "conv-1"
    } as DbConversation);
    vi.mocked(insertMessage).mockRejectedValue(
      new Error("insertMessage failed: duplicate key value violates unique constraint messages_platform_message_id_key")
    );
    vi.mocked(enqueueJob).mockResolvedValue({
      job: { id: "job-existing" } as DbJob,
      created: false
    });

    const client = createMockSupabaseClient({
      existingMessageData: {
        id: "msg-existing",
        conversation_id: "conv-existing"
      }
    });

    const result = await ingestInboundDmEvent(client, {
      platform: "x",
      platformMessageId: "pm-existing",
      platformUserId: "user-1",
      receivedAtIso: "2026-02-11T00:00:00.000Z",
      text: "hello again"
    });

    expect(result).toEqual({
      conversationId: "conv-existing",
      messageId: "msg-existing",
      jobId: "job-existing",
      messageCreated: false,
      jobCreated: false
    });
  });
});
