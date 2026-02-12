create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('x')),
  platform_user_id text not null,
  handle text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (platform, platform_user_id)
);

create index if not exists users_platform_user_id_idx
  on public.users (platform_user_id);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'blocked')),
  last_message_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  platform text not null check (platform in ('x')),
  direction text not null check (direction in ('inbound', 'outbound')),
  platform_message_id text,
  text_content text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists messages_platform_message_id_key
  on public.messages (platform_message_id)
  where platform_message_id is not null;

create index if not exists messages_conversation_id_idx
  on public.messages (conversation_id);

create index if not exists messages_conversation_occurred_at_idx
  on public.messages (conversation_id, occurred_at desc);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  status text not null check (status in ('queued', 'processing', 'done', 'failed')),
  payload jsonb not null,
  dedupe_key text not null,
  attempt_count integer not null default 0,
  run_after timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  locked_by text,
  error_code text,
  error_message text,
  error_stack text,
  last_attempt_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (dedupe_key)
);

create index if not exists jobs_status_idx
  on public.jobs (status);

create index if not exists jobs_status_run_after_idx
  on public.jobs (status, run_after asc);

create table if not exists public.memory_summaries (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  summary text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  fact_key text not null,
  fact_value text not null,
  confidence numeric(4, 3),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (conversation_id, fact_key)
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'inactive',
  plan text not null default 'none',
  credits_remaining integer not null default 0,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists entitlements_user_id_idx
  on public.entitlements (user_id);

create table if not exists public.rate_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  scope text not null,
  window_start timestamptz not null,
  window_seconds integer not null,
  request_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, scope, window_start)
);

create index if not exists rate_limits_user_id_scope_idx
  on public.rate_limits (user_id, scope);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row execute procedure public.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
before update on public.conversations
for each row execute procedure public.set_updated_at();

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
before update on public.messages
for each row execute procedure public.set_updated_at();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
before update on public.jobs
for each row execute procedure public.set_updated_at();

drop trigger if exists memory_summaries_set_updated_at on public.memory_summaries;
create trigger memory_summaries_set_updated_at
before update on public.memory_summaries
for each row execute procedure public.set_updated_at();

drop trigger if exists memory_facts_set_updated_at on public.memory_facts;
create trigger memory_facts_set_updated_at
before update on public.memory_facts
for each row execute procedure public.set_updated_at();

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
before update on public.entitlements
for each row execute procedure public.set_updated_at();

drop trigger if exists rate_limits_set_updated_at on public.rate_limits;
create trigger rate_limits_set_updated_at
before update on public.rate_limits
for each row execute procedure public.set_updated_at();
