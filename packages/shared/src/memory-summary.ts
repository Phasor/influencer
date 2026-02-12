import type { DbMessage } from "./types";

export function shouldRefreshMemorySummary(inboundCount: number, everyInboundMessages: number): boolean {
  if (inboundCount < 1) {
    return false;
  }
  if (everyInboundMessages < 1) {
    throw new Error("everyInboundMessages must be >= 1");
  }
  return inboundCount % everyInboundMessages === 0;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildMemorySummaryFromMessages(messages: DbMessage[], maxChars: number): string {
  if (maxChars < 1) {
    throw new Error("maxChars must be >= 1");
  }

  const lines = messages
    .map((message) => {
      const content = normalizeText(message.text_content);
      if (!content) {
        return "";
      }
      const speaker = message.direction === "inbound" ? "User" : "Assistant";
      return `${speaker}: ${content}`;
    })
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const summary = lines.join("\n");
  if (summary.length <= maxChars) {
    return summary;
  }

  return `${summary.slice(0, maxChars - 1)}…`;
}
