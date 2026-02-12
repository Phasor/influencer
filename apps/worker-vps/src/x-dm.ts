export type SendXDirectMessageParams = {
  accessToken: string;
  recipientUserId: string;
  text: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type XDmResponse = {
  data?: {
    id?: string;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;

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

  const response = await fetchWithTimeout(
    fetchImpl,
    `https://api.x.com/2/dm_conversations/with/${params.recipientUserId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.accessToken}`,
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
