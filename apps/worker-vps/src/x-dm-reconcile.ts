import { createHmac, randomUUID } from "node:crypto";

import type { InboundDmEvent } from "@ai-influencer/shared";

type RawDmEvent = {
  id?: string;
  event_type?: string;
  text?: string;
  sender_id?: string;
  created_at?: string;
};

type DmEventsResponse = {
  data?: RawDmEvent[];
};

function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuthAuthorizationHeader(params: {
  method: string;
  requestUrl: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  timestamp: number;
  nonce: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: params.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(params.timestamp),
    oauth_token: params.accessToken,
    oauth_version: "1.0"
  };

  const parsedUrl = new URL(params.requestUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  const queryEntries = Array.from(parsedUrl.searchParams.entries());
  const allParams = [...Object.entries(oauthParams), ...queryEntries];
  const normalized = allParams
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
    .sort(([aKey, aVal], [bKey, bVal]) =>
      aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey)
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const baseString = [
    params.method.toUpperCase(),
    rfc3986Encode(baseUrl),
    rfc3986Encode(normalized)
  ].join("&");
  const signingKey = `${rfc3986Encode(params.consumerSecret)}&${rfc3986Encode(params.accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString, "utf8").digest("base64");

  const authParams = {
    ...oauthParams,
    oauth_signature: signature
  };
  return `OAuth ${Object.entries(authParams)
    .map(([key, value]) => `${rfc3986Encode(key)}="${rfc3986Encode(value)}"`)
    .join(", ")}`;
}

function parseEventToInbound(
  raw: RawDmEvent,
  params: { botUserId: string; cutoffIso: string }
): InboundDmEvent | null {
  if (raw.event_type !== "MessageCreate") {
    return null;
  }
  const platformMessageId = raw.id?.trim();
  const platformUserId = raw.sender_id?.trim();
  const text = raw.text?.trim();
  const createdAt = raw.created_at?.trim();
  if (!platformMessageId || !platformUserId || !text || !createdAt) {
    return null;
  }
  if (platformUserId === params.botUserId) {
    return null;
  }
  if (Date.parse(createdAt) < Date.parse(params.cutoffIso)) {
    return null;
  }

  return {
    platform: "x",
    platformMessageId,
    platformUserId,
    receivedAtIso: createdAt,
    text
  };
}

function maxDmEventId(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return BigInt(a) >= BigInt(b) ? a : b;
  }
  return a >= b ? a : b;
}

export async function fetchReconciliationInboundEvents(params: {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  botUserId: string;
  pageSize: number;
  cutoffIso: string;
  sinceId?: string | null;
  fetchImpl?: typeof fetch;
  timestampFactory?: () => number;
  nonceFactory?: () => string;
}): Promise<{ events: InboundDmEvent[]; highestEventId: string | null }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestUrl = new URL("https://api.x.com/2/dm_events");
  requestUrl.searchParams.set(
    "dm_event.fields",
    "id,event_type,text,sender_id,created_at"
  );
  requestUrl.searchParams.set("max_results", String(params.pageSize));
  if (params.sinceId) {
    requestUrl.searchParams.set("since_id", params.sinceId);
  }

  const timestamp = params.timestampFactory?.() ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonceFactory?.() ?? randomUUID();
  const authorization = buildOAuthAuthorizationHeader({
    method: "GET",
    requestUrl: requestUrl.toString(),
    consumerKey: params.consumerKey,
    consumerSecret: params.consumerSecret,
    accessToken: params.accessToken,
    accessSecret: params.accessSecret,
    timestamp,
    nonce
  });

  const response = await fetchImpl(requestUrl.toString(), {
    method: "GET",
    headers: {
      authorization
    }
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`X DM reconciliation fetch failed: ${response.status} ${responseText}`);
  }

  const json = JSON.parse(responseText) as DmEventsResponse;
  const rows = Array.isArray(json.data) ? json.data : [];
  let highestEventId: string | null = params.sinceId ?? null;

  const events = rows
    .map((row) => {
      highestEventId = maxDmEventId(highestEventId, row.id?.trim() ?? null);
      return parseEventToInbound(row, {
        botUserId: params.botUserId,
        cutoffIso: params.cutoffIso
      });
    })
    .filter((event): event is InboundDmEvent => event !== null);

  return {
    events,
    highestEventId
  };
}
