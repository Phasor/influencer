import { describe, expect, it, vi } from "vitest";

import { fetchReconciliationInboundEvents } from "./x-dm-reconcile";

describe("fetchReconciliationInboundEvents", () => {
  it("returns only inbound MessageCreate events newer than cutoff", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "100",
              event_type: "MessageCreate",
              sender_id: "bot-1",
              text: "ignore self",
              created_at: "2026-02-16T10:00:00.000Z"
            },
            {
              id: "101",
              event_type: "ParticipantsJoin",
              sender_id: "user-1",
              text: "ignore non-message",
              created_at: "2026-02-16T10:01:00.000Z"
            },
            {
              id: "102",
              event_type: "MessageCreate",
              sender_id: "user-1",
              text: "hello",
              created_at: "2026-02-16T10:05:00.000Z"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await fetchReconciliationInboundEvents({
      consumerKey: "k",
      consumerSecret: "s",
      accessToken: "at",
      accessSecret: "as",
      botUserId: "bot-1",
      pageSize: 50,
      cutoffIso: "2026-02-16T10:02:00.000Z",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timestampFactory: () => 1700000000,
      nonceFactory: () => "nonce-1"
    });

    expect(result.highestEventId).toBe("102");
    expect(result.events).toEqual([
      {
        platform: "x",
        platformMessageId: "102",
        platformUserId: "user-1",
        receivedAtIso: "2026-02-16T10:05:00.000Z",
        text: "hello"
      }
    ]);
  });
});
