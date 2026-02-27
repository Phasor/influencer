# CLAUDE.md — AI Influencer Codebase Guide

This document describes the repository structure, development workflows, and conventions for AI assistants working in this codebase.

---

## Project Overview

**AI Influencer** is a TypeScript monorepo that implements an X (Twitter) DM auto-responder bot. It uses a Vercel serverless webhook to receive DM events quickly, a long-running VPS worker to process jobs and send AI-generated replies, and Supabase as the database. The LLM replies are generated through OpenRouter.

The bot persona is **Emily Voss**, an 18-year-old London-based influencer.

---

## Repository Layout

```
ai-influencer/
├── apps/
│   ├── webhook-vercel/     # Vercel serverless function: receives X webhook POSTs
│   └── worker-vps/         # Long-running Node.js process: processes jobs, sends DMs
├── packages/
│   └── shared/             # Shared types, DB helpers, env config, X utilities
├── supabase/
│   └── migrations/         # SQL schema migrations (apply in order)
├── tsconfig.base.json      # Base TS config (strict, ES2022, path aliases)
├── tsconfig.build.json     # Composite build config referencing all packages
├── vitest.config.ts        # Test runner config (Node environment)
├── eslint.config.mjs       # ESLint with TypeScript rules + Prettier integration
├── .prettierrc             # Prettier: double quotes, semicolons, width 100, no trailing comma
├── .env.example            # All required and optional env vars with placeholders
├── README.md               # Quick-start and ops reference
└── PRD.md                  # Full product requirements document
```

### Package names

| Directory | Package name |
|---|---|
| `packages/shared` | `@ai-influencer/shared` |
| `apps/webhook-vercel` | `@ai-influencer/webhook-vercel` |
| `apps/worker-vps` | `@ai-influencer/worker-vps` |

---

## Development Workflow

### Prerequisites

- Node.js `>=20`
- npm `>=10`

### Setup

```bash
npm install
cp .env.example .env
# Fill in all required values in .env
```

### Common commands (run from repo root)

```bash
npm run typecheck        # Type-check all packages (tsc --noEmit)
npm test                 # Run all tests with Vitest (vitest run)
npm run test:watch       # Vitest in watch mode
npm run lint             # ESLint across all packages
npm run format           # Prettier check (read-only)
npm run format:write     # Prettier auto-fix
npm run build            # Compile TypeScript (required before running worker scripts)
```

### Running the worker

```bash
npm run build
npm run --workspace @ai-influencer/worker-vps start
```

### Admin scripts

```bash
# Inspect current job queue snapshot
npm run --workspace @ai-influencer/worker-vps admin:inspect-jobs

# Check delivery lag / queue health (exits with code 2 when degraded)
npm run --workspace @ai-influencer/worker-vps admin:delivery-health
```

---

## Package Internals

### `packages/shared/src/`

| File | Purpose |
|---|---|
| `types.ts` | All shared TypeScript types: `Platform`, `JobStatus`, `JobType`, `DbUser`, `DbMessage`, `DbJob`, etc. |
| `db.ts` | All database operations via Supabase client. Single source of truth for DB access. |
| `env.ts` | `loadRuntimeConfig()` (worker) and `loadWebhookRuntimeConfig()` (webhook). Validates all env vars at startup. |
| `x-normalize.ts` | `normalizeXInboundDmEvent()`: parses raw X webhook payload into typed `InboundDmEvent`. |
| `x-signature.ts` | HMAC-SHA256 webhook signature creation, verification, and CRC challenge response. |
| `ingest.ts` | `ingestInboundDmEvent()`: idempotent write of user + conversation + message + job. |
| `memory-summary.ts` | Conversation summary helpers: should-refresh check, build-from-messages. |

### `apps/webhook-vercel/src/index.ts`

Exports `GET` and `POST` as Vercel edge function handlers:
- `GET`: responds to X CRC challenge for webhook registration
- `POST`: verifies X signature → inserts `webhook_receipt` row → enqueues `ingest_webhook_receipt` job → returns `{ ok, requestId }` immediately

The handler must return as fast as possible. No LLM or X API calls happen here.

### `apps/worker-vps/src/`

| File | Purpose |
|---|---|
| `cli.ts` | Entry point. Initializes runtime, handles SIGINT/SIGTERM graceful shutdown. |
| `index.ts` | Core worker: `createWorkerRuntime()`, job processors, main poll loop. |
| `openrouter.ts` | `generateOpenRouterReply()`: calls OpenRouter chat completion API with retries. |
| `x-dm.ts` | `sendXDirectMessage()`: sends DM via X API v2 with OAuth1 auth. |
| `x-dm-reconcile.ts` | Polls X API directly for recent DMs as a fallback to webhooks. |
| `x-replay.ts` | Triggers X webhook replay backfill for a configurable time window. |
| `admin-inspect-jobs.ts` | CLI: prints job queue snapshot. |
| `admin-delivery-health.ts` | CLI: reports delivery lag; exits 2 if degraded. |

---

## Architecture and Data Flow

```
X Platform
    │  POST /api/x/webhook (DM event)
    ▼
Vercel Webhook (webhook-vercel)
    │  1. Verify X HMAC signature
    │  2. Insert webhook_receipt (raw payload)
    │  3. Enqueue ingest_webhook_receipt job
    │  Returns 200 immediately
    ▼
Supabase (jobs table)
    │  Worker polls for queued jobs
    ▼
VPS Worker — processIngestWebhookReceiptJob
    │  Parse DM events from receipt
    │  Skip self-authored messages
    │  ingestInboundDmEvent() per message:
    │    upsertUser → getOrCreateConversation → insertMessage → enqueueJob
    ▼
VPS Worker — processRespondToInboundDmJob
    │  Fetch inbound message + conversation context
    │  Check outbound idempotency (existing reply?)
    │  Apply moderation filter
    │  Check rate limit (5 DMs/min per user)
    │  generateOpenRouterReply() with memory summary
    │  sendXDirectMessage() via X API v2 + OAuth1
    │  recordOutboundSendAttempt()
    │  Refresh memory summary if needed (every 10 messages)
```

### Job types

| Job type | Description |
|---|---|
| `ingest_webhook_receipt` | Parse raw webhook payload and create inbound message records |
| `respond_to_inbound_dm` | Generate and send an AI reply to a specific inbound DM |

### Reliability mechanisms

- **Webhook receipts**: raw payload stored before any processing; decouples ingress from processing
- **Job deduplication**: `jobs.dedupe_key` unique index prevents duplicate jobs
- **Outbound idempotency**: `outbound_send_attempts.inbound_message_platform_id` prevents duplicate sends
- **Retry with backoff**: up to 5 attempts per job; delays: 1s, 2s, 4s, 8s, 16s; then dead-letter
- **Stale lock recovery**: jobs locked for >60s are reclaimed by the next poll cycle
- **DM reconciliation**: periodic X API poll as a fallback when webhooks miss events
- **Replay backfill**: optional X webhook replay for a configurable time window

---

## Database Schema

Migrations live in `supabase/migrations/` and must be applied in filename order.

| Table | Purpose |
|---|---|
| `users` | One row per platform user; unique on `(platform, platform_user_id)` |
| `conversations` | One per user (unique on `user_id`); tracks `last_message_at` |
| `messages` | All inbound/outbound messages; unique on `platform_message_id` |
| `jobs` | Job queue; unique on `dedupe_key`; indexed on `(status, run_after)` |
| `memory_summaries` | Rolling conversation summary text per conversation |
| `memory_facts` | Key-value facts per conversation (future use) |
| `entitlements` | Paywall scaffolding (future use) |
| `rate_limits` | Per-user rate limit windows; unique on `(user_id, scope, window_start)` |
| `outbound_send_attempts` | Idempotency record for sent DMs |
| `webhook_receipts` | Raw incoming webhook payloads with processing status |

All tables have `created_at` and `updated_at` with auto-update triggers. Primary keys are `uuid` (`gen_random_uuid()`).

---

## Code Conventions

### TypeScript

- **Strict mode**: `"strict": true` in tsconfig. No `any` without explicit cast.
- **No implicit any**: ESLint enforces `@typescript-eslint/no-explicit-any` as an error.
- **Path aliases**: `@ai-influencer/shared` resolves to `packages/shared/src/index.ts` via tsconfig.

### Naming

| Context | Convention |
|---|---|
| Variables, functions, parameters | `camelCase` |
| Types and interfaces | `PascalCase` |
| Database column names | `snake_case` |
| Environment variables | `UPPER_SNAKE_CASE` |
| Constants | `UPPER_SNAKE_CASE` |
| DB type prefix | `Db` (e.g., `DbUser`, `DbJob`) |
| Input type suffix | `Input` or descriptive (e.g., `InboundDmEvent`) |

### Formatting

Enforced by Prettier (`.prettierrc`):
- Double quotes
- Semicolons: yes
- Trailing commas: none
- Print width: 100

Run `npm run format:write` to auto-fix.

### Patterns to follow

**Dependency injection for testability**: Functions that call external services (DB, X API, OpenRouter) accept a `dependencies` parameter object. Tests pass mock implementations; production code passes real implementations. Follow this pattern for any new external calls.

**Idempotency at every boundary**: DB writes use upsert or check-before-insert patterns. Job creation uses `dedupe_key`. Outbound sends check `outbound_send_attempts` before calling the X API.

**Fail fast on env**: Call `loadRuntimeConfig()` or `loadWebhookRuntimeConfig()` at startup. Both functions throw immediately if any required env var is missing.

**Structured JSON logging**: Log significant events as JSON objects with an `event` field (e.g., `{ event: "worker_heartbeat", ... }`). Do not use unstructured `console.log` strings for events that matter operationally.

**Webhook handlers must be fast**: The Vercel handler must write to DB and return. Never call OpenRouter or the X DM API from the webhook handler.

**No hardcoded secrets**: All credentials come from environment variables. `.env` is gitignored.

### Error handling

- Throw `Error` with a descriptive message for programming errors (missing config, unexpected API shape).
- Use `try/catch` around external API calls; log the error and allow job retry via the retry mechanism.
- Duplicate-key conflicts on `platform_message_id` or `dedupe_key` are expected and should be treated as no-ops, not errors.

---

## Testing

**Framework**: Vitest 3.x

Tests live alongside source files as `*.test.ts`. The vitest config includes:
- `packages/**/*.test.ts`
- `apps/**/*.test.ts`

```bash
npm test              # Run once
npm run test:watch    # Watch mode
```

**Mocking strategy**:
- External HTTP calls (X API, OpenRouter) are mocked via injected dependency functions.
- Supabase client is mocked by passing a mock object as the `db` dependency.
- Pure utility functions (signature verification, payload normalization, retry math) are tested without mocks.

When adding new functionality that calls external services, inject those calls through the `dependencies` pattern so they can be mocked in tests.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all required values.

### Required

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `OPENROUTER_MODEL` | Model ID (e.g., `meta-llama/llama-3.1-70b-instruct`) |
| `X_APP_KEY` | X app consumer key |
| `X_APP_SECRET` | X app consumer secret |
| `X_ACCESS_TOKEN` | Bot account OAuth1 access token |
| `X_ACCESS_SECRET` | Bot account OAuth1 access secret |
| `X_WEBHOOK_SECRET` | Secret for verifying X webhook signatures |
| `WORKER_POLL_INTERVAL_MS` | How often the worker polls for new jobs (e.g., `1000`) |
| `MAX_CONTEXT_MESSAGES` | Number of recent messages included in LLM prompt (e.g., `20`) |
| `MAX_REPLY_CHARS` | Maximum reply length in characters (e.g., `500`) |

### Optional / Feature flags

| Variable | Default | Description |
|---|---|---|
| `X_WEBHOOK_ID` | — | Required only if replay backfill is enabled |
| `ENABLE_X_REPLAY_BACKFILL` | `false` | Enable periodic X webhook replay |
| `X_REPLAY_INTERVAL_MS` | `300000` | How often to trigger replay (ms) |
| `X_REPLAY_WINDOW_MINUTES` | `120` | Window covered by each replay |
| `ENABLE_DM_RECONCILIATION` | `true` | Enable X API polling fallback |
| `DM_RECONCILIATION_INTERVAL_MS` | `600000` | How often to run reconciliation |
| `DM_RECONCILIATION_LOOKBACK_MINUTES` | `180` | Lookback window for reconciliation |
| `DM_RECONCILIATION_PAGE_SIZE` | `50` | X API pagination size |
| `DELIVERY_LAG_ALERT_MINUTES` | `20` | Lag threshold for `admin:delivery-health` |

---

## Deployment

### Webhook (Vercel)

- Deploy `apps/webhook-vercel` to Vercel via Git integration.
- Set all required env vars in Vercel project settings.
- Route: `GET /api/x/webhook` (CRC) and `POST /api/x/webhook` (events).

### Worker (VPS)

- Build first: `npm run build`
- Run as a systemd service or via PM2.
- Needs all required env vars (typically via `.env` file or systemd `EnvironmentFile`).
- Emits `worker_heartbeat` log event every ~60 seconds for monitoring.

### Database

- Supabase project hosted externally.
- Apply migrations from `supabase/migrations/` in filename order via Supabase CLI or dashboard.

---

## Key Design Constraints

1. **Webhook handler is fire-and-forget**: It stores the raw payload and returns 200. All processing happens asynchronously in the worker.
2. **One worker process per deployment**: The worker is not horizontally scaled; the job claiming mechanism uses a stale-lock approach rather than distributed locks.
3. **Rate limit is intentionally minimal**: 5 DMs/minute per user is an MVP default. Tune before production scale.
4. **Moderation is keyword-based**: Basic keyword filtering (harmful content). This is intentionally minimal MVP.
5. **Memory summary resets every 10 inbound messages**: Summary is truncated to 1,200 characters to keep prompt size bounded.
6. **No frontend**: This is a backend-only service.
