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
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      accessToken: "token",
      accessSecret: "token-secret",
      recipientUserId: "user-1",
      text: "hi",
      timestampFactory: () => 1_760_000_000,
      nonceFactory: () => "nonce-1",
      fetchImpl
    });

    expect(result).toEqual({
      platformMessageId: "123"
    });
    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const authorizationHeader = (requestInit.headers as Record<string, string>).authorization ?? "";
    expect(authorizationHeader.startsWith("OAuth ")).toBe(true);
    expect(authorizationHeader).toContain('oauth_signature_method="HMAC-SHA1"');
  });

  it("throws on unsuccessful status code", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    await expect(
      sendXDirectMessage({
        consumerKey: "consumer-key",
        consumerSecret: "consumer-secret",
        accessToken: "token",
        accessSecret: "token-secret",
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
        consumerKey: "consumer-key",
        consumerSecret: "consumer-secret",
        accessToken: "token",
        accessSecret: "token-secret",
        recipientUserId: "user-1",
        text: "hi",
        fetchImpl
      })
    ).rejects.toThrow("response missing message id");
  });
});
