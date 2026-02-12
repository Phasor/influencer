import { createHmac, timingSafeEqual } from "node:crypto";

function normalizeSignatureHeader(signatureHeader: string): string {
  const trimmed = signatureHeader.trim();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

export function createXWebhookSignature(rawBody: string, webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("base64");
}

export function verifyXWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  webhookSecret: string;
}): boolean {
  const { rawBody, signatureHeader, webhookSecret } = params;

  if (!signatureHeader) {
    return false;
  }

  const provided = normalizeSignatureHeader(signatureHeader);
  const expected = createXWebhookSignature(rawBody, webhookSecret);

  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
