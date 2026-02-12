import { randomUUID } from "node:crypto";

import {
  createSupabaseServiceClient,
  type InboundDmEvent,
  ingestInboundDmEvent,
  loadWebhookRuntimeConfig,
  normalizeXInboundDmEvent,
  type WebhookRuntimeConfig,
  verifyXWebhookSignature
} from "@ai-influencer/shared";

export type WebhookResponse = {
  status: number;
  body: {
    ok: boolean;
    requestId: string;
  };
};

type Logger = Pick<Console, "info" | "error">;

type HandleWebhookPostDependencies = {
  logger?: Logger;
  requestIdFactory?: () => string;
  runtimeConfig?: WebhookRuntimeConfig;
  supabaseClient?: ReturnType<typeof createSupabaseServiceClient>;
  rawBody?: string;
  signatureHeader?: string | null;
  normalizeEvent?: (rawPayload: unknown) => InboundDmEvent;
  verifySignature?: (params: {
    rawBody: string;
    signatureHeader: string | null | undefined;
    webhookSecret: string;
  }) => boolean;
  ingestEvent?: (
    client: ReturnType<typeof createSupabaseServiceClient>,
    event: InboundDmEvent
  ) => Promise<{
    conversationId: string;
    messageId: string;
    jobId: string;
    messageCreated: boolean;
    jobCreated: boolean;
  }>;
};

export type VercelWebhookHandlerDependencies = Omit<
  HandleWebhookPostDependencies,
  "rawBody" | "signatureHeader"
>;

function isInvalidPayloadError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Invalid X DM payload:");
}

export async function handleXWebhookPost(
  rawPayload: unknown,
  dependencies: HandleWebhookPostDependencies = {}
): Promise<WebhookResponse> {
  const logger = dependencies.logger ?? console;
  const requestId = dependencies.requestIdFactory?.() ?? randomUUID();
  const normalizeEvent = dependencies.normalizeEvent ?? normalizeXInboundDmEvent;
  const ingestEvent = dependencies.ingestEvent ?? ingestInboundDmEvent;
  const verifySignature = dependencies.verifySignature ?? verifyXWebhookSignature;

  try {
    const config = dependencies.runtimeConfig ?? loadWebhookRuntimeConfig();
    const signatureValid = verifySignature({
      rawBody: dependencies.rawBody ?? JSON.stringify(rawPayload),
      signatureHeader: dependencies.signatureHeader ?? null,
      webhookSecret: config.X_WEBHOOK_SECRET
    });

    if (!signatureValid) {
      logger.error(
        JSON.stringify({
          event: "inbound_rejected",
          request_id: requestId,
          status: 401,
          error_message: "invalid webhook signature"
        })
      );

      return {
        status: 401,
        body: {
          ok: false,
          requestId
        }
      };
    }

    const event = normalizeEvent(rawPayload);
    const supabaseClient =
      dependencies.supabaseClient ??
      createSupabaseServiceClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

    const ingestResult = await ingestEvent(supabaseClient, event);

    logger.info(
      JSON.stringify({
        event: "inbound_accepted",
        request_id: requestId,
        message_id: event.platformMessageId,
        conversation_id: ingestResult.conversationId,
        job_id: ingestResult.jobId
      })
    );

    return {
      status: 200,
      body: {
        ok: true,
        requestId
      }
    };
  } catch (error) {
    const status = isInvalidPayloadError(error) ? 400 : 500;

    logger.error(
      JSON.stringify({
        event: "inbound_rejected",
        request_id: requestId,
        status,
        error_message: error instanceof Error ? error.message : "unknown error"
      })
    );

    return {
      status,
      body: {
        ok: false,
        requestId
      }
    };
  }
}

export function createWebhookRuntime() {
  return {
    name: "webhook-vercel",
    handlePost: handleXWebhookPost
  };
}

function getSignatureHeader(headers: Headers): string | null {
  return (
    headers.get("x-twitter-webhooks-signature") ??
    headers.get("x-signature") ??
    headers.get("x-hub-signature-256")
  );
}

function jsonResponse(body: WebhookResponse["body"], status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

export function createVercelWebhookPostHandler(dependencies: VercelWebhookHandlerDependencies = {}) {
  return async function POST(request: Request): Promise<Response> {
    const rawBody = await request.text();

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawBody);
    } catch {
      const requestId = dependencies.requestIdFactory?.() ?? randomUUID();
      return jsonResponse(
        {
          ok: false,
          requestId
        },
        400
      );
    }

    const result = await handleXWebhookPost(rawPayload, {
      ...dependencies,
      rawBody,
      signatureHeader: getSignatureHeader(request.headers)
    });

    return jsonResponse(result.body, result.status);
  };
}

export const POST = createVercelWebhookPostHandler();
