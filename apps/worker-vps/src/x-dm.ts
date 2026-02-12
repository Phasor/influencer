import { createHmac, randomUUID } from "node:crypto";

export type SendXDirectMessageParams = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
  recipientUserId: string;
  text: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  timestampFactory?: () => number;
  nonceFactory?: () => string;
};

type XDmResponse = {
  data?: {
    id?: string;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;

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
  const allParams = [
    ...Object.entries(oauthParams),
    ...queryEntries
  ];
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

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  request: string | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(request, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendXDirectMessage(
  params: SendXDirectMessageParams
): Promise<{ platformMessageId: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timestamp = params.timestampFactory?.() ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonceFactory?.() ?? randomUUID();
  const requestUrl = `https://api.x.com/2/dm_conversations/with/${params.recipientUserId}/messages`;
  const authorizationHeader = buildOAuthAuthorizationHeader({
    method: "POST",
    requestUrl,
    consumerKey: params.consumerKey,
    consumerSecret: params.consumerSecret,
    accessToken: params.accessToken,
    accessSecret: params.accessSecret,
    timestamp,
    nonce
  });

  const response = await fetchWithTimeout(
    fetchImpl,
    requestUrl,
    {
      method: "POST",
      headers: {
        authorization: authorizationHeader,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text: params.text
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`X DM send failed: ${response.status} ${details}`);
  }

  const json = (await response.json()) as XDmResponse;
  const platformMessageId = json.data?.id?.trim();
  if (!platformMessageId) {
    throw new Error("X DM send failed: response missing message id");
  }
  return {
    platformMessageId
  };
}
