export type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenRouterChatChoice = {
  message?: {
    content?: string;
  };
};

type OpenRouterChatResponse = {
  choices?: OpenRouterChatChoice[];
};

export type GenerateOpenRouterReplyParams = {
  apiKey: string;
  model: string;
  messages: OpenRouterChatMessage[];
  maxReplyChars: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

function estimateMaxTokens(maxReplyChars: number): number {
  if (maxReplyChars < 1) {
    throw new Error("maxReplyChars must be >= 1");
  }
  // 4 chars/token is a practical approximation for short chat replies.
  return Math.max(1, Math.ceil(maxReplyChars / 4));
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars < 1) {
    throw new Error("maxReplyChars must be >= 1");
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
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

export async function generateOpenRouterReply(
  params: GenerateOpenRouterReplyParams
): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = params.retries ?? DEFAULT_RETRIES;
  const maxTokens = params.maxTokens ?? estimateMaxTokens(params.maxReplyChars);

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${params.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            max_tokens: maxTokens
          })
        },
        timeoutMs
      );

      if (!response.ok) {
        const details = await response.text();
        throw new Error(`OpenRouter request failed: ${response.status} ${details}`);
      }

      const json = (await response.json()) as OpenRouterChatResponse;
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("OpenRouter response missing assistant content");
      }

      return truncateText(content, params.maxReplyChars);
    } catch (error) {
      lastError = error;
      if (attempt > retries) {
        break;
      }
    }
  }

  throw new Error(
    `generateOpenRouterReply failed after retries: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`
  );
}
