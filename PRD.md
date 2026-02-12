# PRD — X DM Auto-Responder AI Influencer (Vercel Webhook + VPS Worker + Supabase + OpenRouter)

## 1. Overview

Build an automated “AI influencer” that responds to incoming Direct Messages (DMs) on X (Twitter). The bot is initially **passive**: it only replies when it receives a DM. The system stores message history and lightweight memory per user in Supabase, and generates replies using an **OpenRouter** API call to an **open-source chat model**.

Architecture is intentionally split:
- **Vercel** hosts a minimal, reliable HTTPS webhook endpoint that receives X DM events and writes them into Supabase quickly.
- **VPS** hosts a long-running worker service that consumes queued jobs from Supabase, generates responses via OpenRouter, sends replies via X API, and persists results.

This design ensures:
- Webhook delivery is reliable and fast (Vercel).
- Long-running tasks, retries, and rate-limit handling are stable (VPS).
- Supabase provides a durable store for message history, job queue, and memory.

Non-goals for initial MVP:
- No proactive posting, no timeline browsing, no multi-platform support (Telegram later).
- No complex tool use (web browsing, file access, etc.).
- No payment gating in MVP (but we design an entitlement layer so it can be added cleanly).

## 2. Goals & Success Criteria

### Goals
1. Reply to X DMs automatically with an influencer-style persona.
2. Maintain per-user conversation history and a basic “memory” layer in Supabase.
3. Ensure robust idempotency: X webhook retries must not cause duplicate replies.
4. Provide a safe, controlled response system with rate limiting and basic moderation.
5. Provide a clear operational footprint: logs, error handling, and basic monitoring hooks.

### Success Criteria
- For 100 concurrent DMing users (2,000 inbound DMs/month), the bot:
  - Replies to >99% of inbound DMs within a target time window (e.g., < 30 seconds typical).
  - Does not duplicate replies for any single inbound message (idempotent).
  - Stores all inbound/outbound messages and can reconstruct a conversation.
  - Does not crash or get stuck on rate-limit errors (retries/backoff).
- Developer success:
  - One-command local dev setup (webhook + worker) using Supabase local or remote.
  - Clear environment variable configuration for Vercel + VPS.

## 3. Users & Use Cases

### Primary User: X DM sender
- Sends DMs to the bot account.
- Expects quick replies with a consistent personality.
- Can have an ongoing multi-turn conversation over time.

### Operator: You (admin/dev)
- Deploys webhook to Vercel and worker to VPS.
- Views logs, inspects conversation data in Supabase.
- Adjusts persona prompts and model selection.

## 4. System Architecture

### 4.1 Logical Components
1. **X Webhook Receiver (Vercel)**
   - Receives DM event payloads from X.
   - Validates authenticity (signature verification).
   - Normalizes payloads into internal message events.
   - Writes inbound message into Supabase.
   - Enqueues a job into a Supabase `jobs` table with dedupe key.
   - Returns 200 quickly.

2. **Job Queue (Supabase)**
   - `jobs` table acts as queue.
   - Idempotency handled via unique `dedupe_key` (e.g., X message id).
   - Worker picks jobs in FIFO-ish order.
   - Supports retries with `run_after` timestamps and status transitions.

3. **Worker Service (VPS)**
   - Polls Supabase for queued jobs.
   - Locks a job (atomic update) to prevent double-processing.
   - Loads conversation context from Supabase (summary + recent messages + facts).
   - Calls OpenRouter with persona + context.
   - Sends reply via X API.
   - Persists outbound message and marks job done.
   - Handles errors: retries with exponential backoff, dead-letter after N attempts.

4. **Memory Layer (Supabase)**
   - Stores full message history.
   - Stores rolling summary per conversation to reduce token usage.
   - Stores key-value facts per conversation (optional in MVP, but scaffold it).

5. **OpenRouter LLM**
   - Provides open-source model inference behind a unified API.
   - Initial model should be a chat-optimized open-source instruct model.
   - Model is configurable by environment variable.

### 4.2 Data Flow
Inbound DM:
1) X -> Vercel webhook
2) Vercel:
   - validate signature
   - upsert user/conversation
   - insert inbound message row
   - insert job row with dedupe key = platform_message_id
3) VPS worker:
   - claim job
   - fetch context
   - generate reply
   - send DM reply via X API
   - insert outbound message row
   - update conversation last_message_at
   - update summary periodically
   - mark job done

### 4.3 Deployment
- Vercel project:
  - `/api/x/webhook` route
  - uses Supabase service role key for server-side writes
- VPS:
  - Node service (systemd or PM2)
  - uses Supabase service role key
  - uses X API credentials to send DMs
  - uses OpenRouter API key to call models

## 5. Requirements

### 5.1 Functional Requirements

#### FR1 — Receive & Persist Inbound DMs
- System must accept incoming DM events from X and store:
  - platform user id
  - message id (unique)
  - timestamp
  - text content
  - direction=inbound

#### FR2 — Enqueue Processing Job (Idempotent)
- For each inbound DM, enqueue exactly one job.
- If X retries the webhook with the same DM, no duplicate jobs are created.
- Use a unique constraint on `dedupe_key`.

#### FR3 — Generate Reply using OpenRouter
- Worker composes prompt:
  - system persona
  - conversation summary (if exists)
  - top facts (if implemented)
  - last N messages
  - user’s latest inbound message
- Worker calls OpenRouter with configured model.
- Worker receives assistant reply text.
- Must support response truncation to avoid extremely long DMs.

#### FR4 — Send Reply as X DM
- Worker sends the generated reply to the original user.
- Outbound DM must be persisted with direction=outbound.
- Must be idempotent: if sending succeeded but DB write failed, system should not send duplicates upon retry (use outbound dedupe keys).

#### FR5 — Conversation Memory
- Store full history in `messages`.
- Maintain:
  - `memory_summaries.summary` updated periodically (e.g., every 10 inbound messages).
  - optional `memory_facts` for stable user details.

#### FR6 — Rate Limiting
- Basic per-user rate limit:
  - e.g., max X messages replied to per minute/hour/day (configurable).
- If exceeded:
  - send short “slow down” message or silently ignore (configurable).
- Store counts in DB to survive restarts.

#### FR7 — Safety / Moderation (Basic)
- A lightweight text filter to detect:
  - spam patterns
  - harassment content
  - requests for dangerous activities
- If triggered:
  - respond with refusal and/or stop responding
  - optionally mark conversation status = blocked

#### FR8 — Observability
- Log key events:
  - inbound accepted
  - job created
  - job claimed
  - model call success/failure
  - dm send success/failure
- Store error metadata on job failure.

### 5.2 Non-Functional Requirements

#### NFR1 — Idempotency & Reliability
- No duplicate replies for a single inbound message.
- Webhook must be fast and respond within typical platform timeouts.

#### NFR2 — Security
- All secrets stored as env vars (Vercel + VPS).
- Webhook signature verification implemented.
- Supabase uses RLS appropriately; server uses service role key only on trusted backends.

#### NFR3 — Cost Control
- Limit context length:
  - last N messages + summary
- Configure max tokens and/or max reply length.
- Track approximate tokens/cost in messages table if available.

#### NFR4 — Extensibility
- Later: add Telegram adapter with same internal event schema.
- Later: add payment gating via entitlements/credits.

## 6. Database Schema (Supabase)

Tables (MVP + scaffold):
- users
- conversations
- messages
- jobs
- memory_summaries (scaffold; initial can be empty)
- memory_facts (scaffold; optional)
- entitlements (scaffold for future paywall)
- rate_limits

Constraints:
- `messages.platform_message_id` unique
- `jobs.dedupe_key` unique
- `users(platform, platform_user_id)` unique

## 7. Prompting & Persona

### Persona Requirements
- Influencer-like, friendly, succinct by default.
- Maintains consistent tone across a user’s conversation.

### Prompt Template (High Level)
System:
- persona rules
- safety rules
- response format constraints (plain text)

Context:
- conversation summary
- known facts
- recent messages

User:
- latest inbound message

## 8. API Integrations

### X API
- Receive DM events: via webhook event subscription or polling if needed.
- Send DMs: endpoint via X API (implementation detail depends on X tier).
- Verify webhook: signature header validation.

### OpenRouter
- POST chat completion to configured model.
- Must support timeout and retries.
- Must record model used.

## 9. Testing Strategy

### Unit Tests
- Payload normalization from X -> internal message event.
- Idempotent job creation logic.
- Prompt builder: ensures correct ordering and truncation.
- Rate limiter logic.

### Integration Tests
- Simulate inbound DM -> webhook -> DB rows created -> job enqueued.
- Worker processes job and writes outbound message (mock X send).
- End-to-end local test with dummy X adapter (no real credentials).

### Manual Tests (staged)
- Use a test X account to DM the bot and observe:
  - single reply
  - conversation continuity
  - rate limits
  - retry behavior (replay same event payload)

## 10. Milestones

M1 — Foundations
- Repo structure, environment config, Supabase schema, shared types.

M2 — Webhook MVP
- Receive + verify + persist inbound message + enqueue job (idempotent).

M3 — Worker MVP
- Poll jobs, build minimal context, call OpenRouter, send reply, persist outbound.

M4 — Reliability
- Idempotent outbound sending, retries/backoff, job locking.

M5 — Memory & Cost Controls
- Summary updates, context truncation, basic token/cost tracking.

M6 — Safety & Rate Limits
- Simple moderation gate, per-user rate limiting, blocklist.

M7 — Operational Polish
- Logs, health checks, admin scripts, docs.

## 11. Out of Scope (for MVP)
- Multi-platform (Telegram), proactive posting, paid gating, analytics dashboard, media attachments, voice, tools, browsing, multi-agent orchestration.

---

# Build Plan — Task Breakdown (Agent-Friendly)

## Phase 0 — Repo Setup & Conventions
0.1 Create monorepo structure:
- /apps/webhook-vercel
- /apps/worker-vps
- /packages/shared (types, prompt builder, db helpers)

0.2 Tooling:
- TypeScript
- Node 20+
- eslint + prettier
- dotenv for local dev
- a test runner (vitest or jest)

0.3 Define environment variable spec (document in README):
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- OPENROUTER_API_KEY
- OPENROUTER_MODEL
- X_APP_KEY / X_APP_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET (or whatever X requires)
- X_WEBHOOK_SECRET (for signature verification)
- WORKER_POLL_INTERVAL_MS
- MAX_CONTEXT_MESSAGES
- MAX_REPLY_CHARS

Deliverables:
- repo compiles
- tests run
- basic shared types exist

## Phase 1 — Supabase Schema + DB Access Layer
1.1 Write SQL migrations for tables:
- users, conversations, messages, jobs
- memory_summaries, memory_facts (scaffold)
- rate_limits, entitlements (scaffold)

1.2 Add constraints and indexes:
- unique keys for idempotency
- indexes on conversation_id, platform_user_id, status

1.3 Implement DB helper functions in /packages/shared:
- upsertUser(platform_user_id, handle?)
- getOrCreateConversation(platform_user_id)
- insertMessage(inbound/outbound)
- enqueueJob(type, payload, dedupe_key)
- claimNextJob()
- markJobDone/Failed(with retry scheduling)
- fetchConversationContext(conversation_id)

Testing:
- unit tests for DB helpers using a local supabase test project or mocked client
- at minimum: test pure logic (dedupe key selection, state transitions)

## Phase 2 — Vercel Webhook Receiver (Ingress)
2.1 Implement POST /api/x/webhook
- verify signature (stub if needed initially, then implement properly)
- parse payload and normalize to internal event
- upsert user + conversation
- insert inbound message with unique platform_message_id
- enqueue job with dedupe_key = platform_message_id
- respond 200 quickly with minimal body

2.2 Add idempotency behavior:
- if message exists, no new job is enqueued
- if job exists, do nothing

2.3 Add basic logging:
- request id
- message id
- conversation id

Testing:
- unit tests for payload normalization
- integration test: call handler with a sample payload and assert DB rows created
- replay same payload and assert no duplicates

## Phase 3 — Worker MVP (Core Loop)
3.1 Create worker process entry:
- load env
- connect to Supabase
- loop: claimNextJob -> process -> sleep

3.2 Implement job claim semantics:
- atomic update from queued -> processing
- set locked_at, locked_by
- if locked too long, allow reclaim (stale lock handling)

3.3 Implement minimal context builder:
- last N messages from conversation
- no summary initially
- format into OpenRouter messages array

3.4 Implement OpenRouter client:
- timeout
- retries
- model from env
- max tokens / max reply chars

3.5 Implement X DM send wrapper:
- minimal send function
- mockable interface for tests

3.6 Persist outbound message + mark job done

Testing:
- worker unit tests:
  - prompt builder truncation
  - OpenRouter request building (mock fetch)
  - job transitions (queued -> processing -> done)
- integration test with mocked X send

## Phase 4 — Reliability & Idempotent Outbound
4.1 Add outbound dedupe strategy:
- record an outbound “send attempt” keyed by inbound message id
- ensure retries do not send duplicate DMs if already sent

4.2 Add retries/backoff:
- job has attempt_count
- on failure, schedule run_after = now + backoff(attempt)
- after max attempts, move to failed (dead-letter)

4.3 Add structured error metadata:
- store error_code, error_message, stack summary
- store last_attempt_at

Testing:
- simulate X send failure then success; ensure single outbound DM
- simulate DB write fail after send; ensure no duplicate send on retry

## Phase 5 — Memory Summaries (Cost Control)
5.1 Implement memory_summaries update policy:
- every K inbound messages, recompute summary
- store summary text

5.2 Update context builder to include summary first, then recent messages

5.3 Optional: memory_facts extractor
- a cheap pass that extracts stable facts (name, preferences)
- store key/value pairs with confidence

Testing:
- ensure summary truncates to a safe size
- ensure context builder respects max tokens/chars rules

## Phase 6 — Rate Limits & Safety
6.1 Implement per-user rate limiter:
- store window_start + count
- block or slow message if exceeded

6.2 Implement basic moderation gate:
- simple keyword/regex + heuristic scoring
- refuse or stop responding based on thresholds
- mark conversation status=blocked if necessary

Testing:
- rate limit boundary tests
- moderation tests for known patterns

## Phase 7 — Ops & Documentation
7.1 Add health endpoints / scripts:
- worker health log line
- admin script to replay jobs, inspect conversations

7.2 Add documentation:
- setup steps
- deploy steps (Vercel + VPS)
- environment variable checklist
- common troubleshooting

7.3 Add minimal monitoring hooks:
- count failed jobs
- log slow processing
- optional webhook to alert channel later

---

# Acceptance Checklist (MVP)
- [ ] Inbound DM -> stored in Supabase
- [ ] Job enqueued idempotently (replay safe)
- [ ] Worker generates reply via OpenRouter
- [ ] Reply sent via X DM
- [ ] Outbound message stored
- [ ] No duplicate replies under webhook retries
- [ ] Basic logs and error handling
- [ ] Basic rate limiting (optional but recommended)
- [ ] Basic memory summary (optional but recommended)
