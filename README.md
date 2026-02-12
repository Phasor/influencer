# AI Influencer — X DM Auto-Responder

This repository is organized as a TypeScript monorepo for the architecture defined in `PRD.md` (Option 2: Vercel webhook + VPS worker + Supabase).

## Current Scope

Implemented so far:
- Monorepo structure and shared package wiring
- Phase 2 webhook ingress (idempotent inbound + queue enqueue)
- Phase 3 worker loop (claim -> process -> send -> persist)
- Phase 4 outbound idempotency + retry metadata
- Phase 5 memory summary refresh + summary-aware prompting
- Phase 6 basic moderation and per-user rate limiting
- Phase 7 operational scripts and heartbeat logging

## Repository Layout

- `apps/webhook-vercel`: serverless webhook ingress service
- `apps/worker-vps`: long-running worker service
- `packages/shared`: shared types and config helpers

## Prerequisites

- Node.js `20+`
- npm `10+`

## Getting Started

1. Install dependencies:
   - `npm install`
2. Create environment file:
   - Copy `.env.example` to `.env`
3. Run validation commands:
   - `npm run typecheck`
   - `npm test`
   - `npm run lint`

## Worker Ops

- Build once before running worker scripts:
  - `npm run build`
- Start worker process:
  - `npm run --workspace @ai-influencer/worker-vps start`
- Inspect queue status snapshot:
  - `npm run --workspace @ai-influencer/worker-vps admin:inspect-jobs`

The worker emits a `worker_heartbeat` structured log roughly once per minute.

## Environment Variables

All secrets must be provided via environment variables. Do not hardcode credentials.

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `X_APP_KEY`
- `X_APP_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`
- `X_WEBHOOK_SECRET`
- `WORKER_POLL_INTERVAL_MS`
- `MAX_CONTEXT_MESSAGES`
- `MAX_REPLY_CHARS`

## Notes

- Webhook handlers must stay minimal and return quickly.
- Long-running work and retries belong in the worker.
- External integrations (X/OpenRouter) will be mocked in tests.
- Rate limits and moderation are intentionally minimal MVP defaults and should be tuned before production scale.
