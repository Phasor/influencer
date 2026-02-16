import * as dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(): void {
  const configuredPath = process.env.DOTENV_CONFIG_PATH;
  if (configuredPath) {
    dotenv.config({ path: configuredPath });
    return;
  }

  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(__dirname, "../../../.env")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }

  dotenv.config();
}

loadDotenv();

const requiredEnvKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "X_APP_KEY",
  "X_APP_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_SECRET",
  "X_WEBHOOK_SECRET",
  "WORKER_POLL_INTERVAL_MS",
  "MAX_CONTEXT_MESSAGES",
  "MAX_REPLY_CHARS"
] as const;

const requiredWebhookEnvKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "X_WEBHOOK_SECRET"
] as const;

export type RequiredEnvKey = (typeof requiredEnvKeys)[number];
export type RequiredWebhookEnvKey = (typeof requiredWebhookEnvKeys)[number];

export type RuntimeConfig = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  X_APP_KEY: string;
  X_APP_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_SECRET: string;
  X_WEBHOOK_SECRET: string;
  X_WEBHOOK_ID: string | null;
  WORKER_POLL_INTERVAL_MS: number;
  MAX_CONTEXT_MESSAGES: number;
  MAX_REPLY_CHARS: number;
  ENABLE_X_REPLAY_BACKFILL: boolean;
  X_REPLAY_INTERVAL_MS: number;
  X_REPLAY_WINDOW_MINUTES: number;
  ENABLE_DM_RECONCILIATION: boolean;
  DM_RECONCILIATION_INTERVAL_MS: number;
  DM_RECONCILIATION_LOOKBACK_MINUTES: number;
  DM_RECONCILIATION_PAGE_SIZE: number;
};

export type WebhookRuntimeConfig = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  X_WEBHOOK_SECRET: string;
};

function getMissingKeys<T extends readonly string[]>(env: NodeJS.ProcessEnv, keys: T): T[number][] {
  return keys.filter((key) => {
    const value = env[key];
    return value === undefined || value.trim() === "";
  });
}

export function getMissingEnvKeys(env: NodeJS.ProcessEnv): RequiredEnvKey[] {
  return getMissingKeys(env, requiredEnvKeys);
}

export function getMissingWebhookEnvKeys(env: NodeJS.ProcessEnv): RequiredWebhookEnvKey[] {
  return getMissingKeys(env, requiredWebhookEnvKeys);
}

function parsePositiveInt(name: keyof RuntimeConfig, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(name: keyof RuntimeConfig, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Environment variable ${name} must be a boolean-like value.`);
}

function parseOptionalPositiveInt(
  name: keyof RuntimeConfig,
  value: string | undefined,
  defaultValue: number
): number {
  if (!value || value.trim().length === 0) {
    return defaultValue;
  }
  return parsePositiveInt(name, value);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const missing = getMissingEnvKeys(env);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const replayBackfillEnabled = parseBoolean(
    "ENABLE_X_REPLAY_BACKFILL",
    env.ENABLE_X_REPLAY_BACKFILL ?? "false"
  );
  const webhookId = env.X_WEBHOOK_ID?.trim() || null;
  if (replayBackfillEnabled && !webhookId) {
    throw new Error("Environment variable X_WEBHOOK_ID is required when ENABLE_X_REPLAY_BACKFILL is true.");
  }

  return {
    SUPABASE_URL: env.SUPABASE_URL as string,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY as string,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY as string,
    OPENROUTER_MODEL: env.OPENROUTER_MODEL as string,
    X_APP_KEY: env.X_APP_KEY as string,
    X_APP_SECRET: env.X_APP_SECRET as string,
    X_ACCESS_TOKEN: env.X_ACCESS_TOKEN as string,
    X_ACCESS_SECRET: env.X_ACCESS_SECRET as string,
    X_WEBHOOK_SECRET: env.X_WEBHOOK_SECRET as string,
    X_WEBHOOK_ID: webhookId,
    WORKER_POLL_INTERVAL_MS: parsePositiveInt(
      "WORKER_POLL_INTERVAL_MS",
      env.WORKER_POLL_INTERVAL_MS as string
    ),
    MAX_CONTEXT_MESSAGES: parsePositiveInt(
      "MAX_CONTEXT_MESSAGES",
      env.MAX_CONTEXT_MESSAGES as string
    ),
    MAX_REPLY_CHARS: parsePositiveInt("MAX_REPLY_CHARS", env.MAX_REPLY_CHARS as string),
    ENABLE_X_REPLAY_BACKFILL: replayBackfillEnabled,
    X_REPLAY_INTERVAL_MS: parseOptionalPositiveInt(
      "X_REPLAY_INTERVAL_MS",
      env.X_REPLAY_INTERVAL_MS,
      300_000
    ),
    X_REPLAY_WINDOW_MINUTES: parseOptionalPositiveInt(
      "X_REPLAY_WINDOW_MINUTES",
      env.X_REPLAY_WINDOW_MINUTES,
      120
    ),
    ENABLE_DM_RECONCILIATION: parseBoolean(
      "ENABLE_DM_RECONCILIATION",
      env.ENABLE_DM_RECONCILIATION ?? "true"
    ),
    DM_RECONCILIATION_INTERVAL_MS: parseOptionalPositiveInt(
      "DM_RECONCILIATION_INTERVAL_MS",
      env.DM_RECONCILIATION_INTERVAL_MS,
      600_000
    ),
    DM_RECONCILIATION_LOOKBACK_MINUTES: parseOptionalPositiveInt(
      "DM_RECONCILIATION_LOOKBACK_MINUTES",
      env.DM_RECONCILIATION_LOOKBACK_MINUTES,
      180
    ),
    DM_RECONCILIATION_PAGE_SIZE: parseOptionalPositiveInt(
      "DM_RECONCILIATION_PAGE_SIZE",
      env.DM_RECONCILIATION_PAGE_SIZE,
      50
    )
  };
}

export function loadWebhookRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WebhookRuntimeConfig {
  const missing = getMissingWebhookEnvKeys(env);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    SUPABASE_URL: env.SUPABASE_URL as string,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY as string,
    X_WEBHOOK_SECRET: env.X_WEBHOOK_SECRET as string
  };
}
