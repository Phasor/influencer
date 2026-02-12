import { describe, expect, it } from "vitest";

import {
  getMissingEnvKeys,
  getMissingWebhookEnvKeys,
  loadRuntimeConfig,
  loadWebhookRuntimeConfig
} from "./env";

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

describe("loadWebhookRuntimeConfig", () => {
  it("requires only webhook-specific environment keys", () => {
    const result = loadWebhookRuntimeConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      X_WEBHOOK_SECRET: "webhook-secret"
    });

    expect(result.SUPABASE_URL).toBe("https://example.supabase.co");
    expect(result.X_WEBHOOK_SECRET).toBe("webhook-secret");
  });

  it("reports missing webhook env keys", () => {
    expect(getMissingWebhookEnvKeys({ SUPABASE_URL: "x" })).toEqual([
      "SUPABASE_SERVICE_ROLE_KEY",
      "X_WEBHOOK_SECRET"
    ]);
  });
});
