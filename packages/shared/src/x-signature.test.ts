import { describe, expect, it } from "vitest";

import {
  createXWebhookCrcResponseToken,
  createXWebhookSignature,
  verifyXWebhookSignature
} from "./x-signature";

describe("createXWebhookCrcResponseToken", () => {
  it("returns a sha256-prefixed base64 token for crc challenge responses", () => {
    const responseToken = createXWebhookCrcResponseToken("crc-token", "test-secret");
    expect(responseToken.startsWith("sha256=")).toBe(true);
  });
});

describe("verifyXWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const rawBody = '{"direct_message_events":[{"id":"1"}]}';
    const webhookSecret = "test-secret";
    const signature = createXWebhookSignature(rawBody, webhookSecret);

    const isValid = verifyXWebhookSignature({
      rawBody,
      signatureHeader: `sha256=${signature}`,
      webhookSecret
    });

    expect(isValid).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const isValid = verifyXWebhookSignature({
      rawBody: '{"hello":"world"}',
      signatureHeader: "sha256=not-valid",
      webhookSecret: "test-secret"
    });

    expect(isValid).toBe(false);
  });

  it("rejects when signature header is missing", () => {
    const isValid = verifyXWebhookSignature({
      rawBody: '{"hello":"world"}',
      signatureHeader: undefined,
      webhookSecret: "test-secret"
    });

    expect(isValid).toBe(false);
  });
});
