import { describe, expect, it, vi } from "vitest";

import { generateOpenRouterReply } from "./openrouter";

describe("generateOpenRouterReply", () => {
  it("returns truncated assistant text from OpenRouter", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "this response should be truncated"
              }
            }
          ]
        }),
        { status: 200 }
      )
    );

    const reply = await generateOpenRouterReply({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      maxReplyChars: 10,
      fetchImpl
    });

    expect(reply).toBe("this respo");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string | URL, RequestInit];
    const requestInit = firstCall[1];
    const body = JSON.parse((requestInit.body as string | undefined) ?? "{}") as {
      max_tokens?: number;
    };
    expect(body.max_tokens).toBe(3);
  });

  it("retries on failure and eventually succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream down", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }]
          }),
          { status: 200 }
        )
      );

    const reply = await generateOpenRouterReply({
      apiKey: "key",
      model: "model",
      messages: [{ role: "user", content: "hello" }],
      maxReplyChars: 500,
      retries: 1,
      fetchImpl
    });

    expect(reply).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
