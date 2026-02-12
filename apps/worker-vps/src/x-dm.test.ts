import { describe, expect, it, vi } from "vitest";

import { sendXDirectMessage } from "./x-dm";

describe("sendXDirectMessage", () => {
  it("returns platform message id for successful send", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            id: "123"
          }
        }),
        { status: 200 }
      )
    );

    const result = await sendXDirectMessage({
      accessToken: "token",
      recipientUserId: "user-1",
      text: "hi",
      fetchImpl
    });

    expect(result).toEqual({
      platformMessageId: "123"
    });
  });

  it("throws on unsuccessful status code", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    await expect(
      sendXDirectMessage({
        accessToken: "token",
        recipientUserId: "user-1",
        text: "hi",
        fetchImpl
      })
    ).rejects.toThrow("X DM send failed");
  });

  it("throws when API response lacks a message id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await expect(
      sendXDirectMessage({
        accessToken: "token",
        recipientUserId: "user-1",
        text: "hi",
        fetchImpl
      })
    ).rejects.toThrow("response missing message id");
  });
});
