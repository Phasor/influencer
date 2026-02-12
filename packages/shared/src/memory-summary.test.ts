import { describe, expect, it } from "vitest";

import { buildMemorySummaryFromMessages, shouldRefreshMemorySummary } from "./memory-summary";
import type { DbMessage } from "./types";

describe("shouldRefreshMemorySummary", () => {
  it("returns true at the configured inbound interval", () => {
    expect(shouldRefreshMemorySummary(10, 10)).toBe(true);
    expect(shouldRefreshMemorySummary(20, 10)).toBe(true);
    expect(shouldRefreshMemorySummary(11, 10)).toBe(false);
  });
});

describe("buildMemorySummaryFromMessages", () => {
  it("formats inbound/outbound turns into compact lines", () => {
    const messages = [
      { direction: "inbound", text_content: "hi   there" },
      { direction: "outbound", text_content: "hello!" }
    ] as DbMessage[];

    const summary = buildMemorySummaryFromMessages(messages, 200);
    expect(summary).toBe("User: hi there\nAssistant: hello!");
  });

  it("truncates summaries to the requested max length", () => {
    const messages = [{ direction: "inbound", text_content: "a".repeat(50) }] as DbMessage[];

    const summary = buildMemorySummaryFromMessages(messages, 20);
    expect(summary.length).toBe(20);
    expect(summary.endsWith("…")).toBe(true);
  });
});
