import { describe, expect, it, vi } from "vitest";

import { createXWebhookCrcResponseToken, createXWebhookSignature } from "@ai-influencer/shared";

import {
  createVercelWebhookGetHandler,
  createVercelWebhookPostHandler,
  handleXWebhookPost
} from "./index";

type SupabaseClientDependency = NonNullable<Parameters<typeof handleXWebhookPost>[1]>["supabaseClient"];
type InjectedSupabaseClient = Exclude<SupabaseClientDependency, undefined>;
type RuntimeConfigDependency = NonNullable<Parameters<typeof handleXWebhookPost>[1]>["runtimeConfig"];
type InjectedRuntimeConfig = Exclude<RuntimeConfigDependency, undefined>;

const runtimeConfig: InjectedRuntimeConfig = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  X_WEBHOOK_SECRET: "test-webhook-secret"
};

describe("handleXWebhookPost", () => {
  it("returns 200 for a valid inbound event and logs ids", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };

    const response = await handleXWebhookPost(
      { raw: "payload" },
      {
        requestIdFactory: () => "req-1",
        logger,
        runtimeConfig,
        supabaseClient: {} as InjectedSupabaseClient,
        signatureHeader: "sha256=test",
        verifySignature: () => true,
        normalizeEvent: () => ({
          platform: "x",
          platformMessageId: "pm-1",
          platformUserId: "user-1",
          receivedAtIso: "2026-02-11T00:00:00.000Z",
          text: "hello"
        }),
        ingestEvent: async () => ({
          conversationId: "conv-1",
          messageId: "msg-1",
          jobId: "job-1",
          messageCreated: true,
          jobCreated: true
        })
      }
    );

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        requestId: "req-1"
      }
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid webhook signature", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };

    const response = await handleXWebhookPost(
      { raw: "payload" },
      {
        requestIdFactory: () => "req-unauthorized",
        logger,
        runtimeConfig,
        signatureHeader: "sha256=bad-signature",
        verifySignature: () => false
      }
    );

    expect(response).toEqual({
      status: 401,
      body: {
        ok: false,
        requestId: "req-unauthorized"
      }
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid payload normalization error", async () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };

    const response = await handleXWebhookPost(
      { raw: "bad payload" },
      {
        requestIdFactory: () => "req-2",
        logger,
        runtimeConfig,
        signatureHeader: "sha256=test",
        verifySignature: () => true,
        normalizeEvent: () => {
          throw new Error("Invalid X DM payload: direct_message_events is required.");
        }
      }
    );

    expect(response).toEqual({
      status: 400,
      body: {
        ok: false,
        requestId: "req-2"
      }
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("createVercelWebhookPostHandler", () => {
  it("returns 200 when signature and payload are valid", async () => {
    const requestPayload = {
      direct_message_events: [
        {
          type: "message_create",
          id: "pm-123",
          created_timestamp: "1760000000000",
          message_create: {
            sender_id: "user-123",
            message_data: {
              text: "hi"
            }
          }
        }
      ]
    };
    const rawBody = JSON.stringify(requestPayload);
    const signature = createXWebhookSignature(rawBody, runtimeConfig.X_WEBHOOK_SECRET);

    const logger = {
      info: vi.fn(),
      error: vi.fn()
    };

    const POST = createVercelWebhookPostHandler({
      logger,
      requestIdFactory: () => "req-route-1",
      runtimeConfig,
      supabaseClient: {} as InjectedSupabaseClient,
      ingestEvent: async () => ({
        conversationId: "conv-1",
        messageId: "msg-1",
        jobId: "job-1",
        messageCreated: true,
        jobCreated: true
      })
    });

    const request = new Request("https://example.com/api/x/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-twitter-webhooks-signature": `sha256=${signature}`
      },
      body: rawBody
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      requestId: "req-route-1"
    });
  });

  it("returns 400 for invalid JSON body", async () => {
    const POST = createVercelWebhookPostHandler({
      requestIdFactory: () => "req-route-bad-json"
    });

    const request = new Request("https://example.com/api/x/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{not valid json"
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      requestId: "req-route-bad-json"
    });
  });
});

describe("createVercelWebhookGetHandler", () => {
  it("returns crc response token for a valid challenge request", async () => {
    const GET = createVercelWebhookGetHandler({
      runtimeConfig,
      requestIdFactory: () => "req-crc-1",
      logger: {
        info: vi.fn(),
        error: vi.fn()
      }
    });

    const request = new Request("https://example.com/api/x/webhook?crc_token=test-crc-token", {
      method: "GET"
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      response_token: createXWebhookCrcResponseToken("test-crc-token", runtimeConfig.X_WEBHOOK_SECRET)
    });
  });

  it("returns 400 when crc_token is missing", async () => {
    const GET = createVercelWebhookGetHandler({
      runtimeConfig,
      requestIdFactory: () => "req-crc-missing"
    });
    const response = await GET(new Request("https://example.com/api/x/webhook", { method: "GET" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      requestId: "req-crc-missing"
    });
  });
});
