import { describe, expect, it } from "vitest";

import { getMissingEnvKeys, loadRuntimeConfig } from "./env";

describe("getMissingEnvKeys", () => {
  it("returns all required keys when env is empty", () => {
    const result = getMissingEnvKeys({});

    expect(result).toContain("SUPABASE_URL");
    expect(result).toContain("X_WEBHOOK_SECRET");
    expect(result.length).toBeGreaterThan(5);
  });
});

describe("loadRuntimeConfig", () => {
  const baseEnv = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    OPENROUTER_API_KEY: "openrouter-key",
    OPENROUTER_MODEL: "open-model",
    X_APP_KEY: "app-key",
    X_APP_SECRET: "app-secret",
    X_ACCESS_TOKEN: "access-token",
    X_ACCESS_SECRET: "access-secret",
    X_WEBHOOK_SECRET: "webhook-secret",
    WORKER_POLL_INTERVAL_MS: "1000",
    MAX_CONTEXT_MESSAGES: "20",
    MAX_REPLY_CHARS: "500"
  };

  it("parses numeric values and returns runtime config", () => {
    const result = loadRuntimeConfig(baseEnv);

    expect(result.WORKER_POLL_INTERVAL_MS).toBe(1000);
    expect(result.MAX_CONTEXT_MESSAGES).toBe(20);
    expect(result.MAX_REPLY_CHARS).toBe(500);
  });

  it("throws for invalid numeric configuration", () => {
    expect(() => {
      loadRuntimeConfig({ ...baseEnv, MAX_REPLY_CHARS: "not-a-number" });
    }).toThrow("MAX_REPLY_CHARS");
  });
});
