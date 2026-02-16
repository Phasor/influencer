import { describe, expect, it, vi } from "vitest";

import { computeReplayWindow, requestXReplayBackfill } from "./x-replay";

describe("computeReplayWindow", () => {
  it("creates a replay window ending 10 minutes behind now", () => {
    const now = new Date("2026-02-16T10:30:00.000Z");
    const window = computeReplayWindow(now, 120);
    expect(window.toDateUtcMinute).toBe("202602161020");
    expect(window.fromDateUtcMinute).toBe("202602160820");
  });

  it("clamps the start date to five days lookback", () => {
    const now = new Date("2026-02-16T10:30:00.000Z");
    const window = computeReplayWindow(now, 60 * 24 * 7);
    expect(window.fromDateUtcMinute).toBe("202602111031");
  });
});

describe("requestXReplayBackfill", () => {
  it("requests app token and then replay endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token_type: "bearer", access_token: "app-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(new Response("", { status: 202 }));

    await requestXReplayBackfill({
      appKey: "app-key",
      appSecret: "app-secret",
      webhookId: "123",
      fromDateUtcMinute: "202602160800",
      toDateUtcMinute: "202602161000",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.x.com/oauth2/token");
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/1.1/account_activity/replay/webhooks/123/");
  });
});
