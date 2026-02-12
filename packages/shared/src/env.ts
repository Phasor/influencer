import * as dotenv from "dotenv";

dotenv.config();

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
  WORKER_POLL_INTERVAL_MS: number;
  MAX_CONTEXT_MESSAGES: number;
  MAX_REPLY_CHARS: number;
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

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const missing = getMissingEnvKeys(env);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
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
    WORKER_POLL_INTERVAL_MS: parsePositiveInt(
      "WORKER_POLL_INTERVAL_MS",
      env.WORKER_POLL_INTERVAL_MS as string
    ),
    MAX_CONTEXT_MESSAGES: parsePositiveInt(
      "MAX_CONTEXT_MESSAGES",
      env.MAX_CONTEXT_MESSAGES as string
    ),
    MAX_REPLY_CHARS: parsePositiveInt("MAX_REPLY_CHARS", env.MAX_REPLY_CHARS as string)
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
