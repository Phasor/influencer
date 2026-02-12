create table if not exists public.outbound_send_attempts (
  id uuid primary key default gen_random_uuid(),
  inbound_message_platform_id text not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  platform text not null check (platform in ('x')),
  recipient_platform_user_id text not null,
  reply_text text not null,
  outbound_platform_message_id text not null,
  sent_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (inbound_message_platform_id),
  unique (outbound_platform_message_id)
);

create index if not exists outbound_send_attempts_conversation_id_idx
  on public.outbound_send_attempts (conversation_id);

drop trigger if exists outbound_send_attempts_set_updated_at on public.outbound_send_attempts;
create trigger outbound_send_attempts_set_updated_at
before update on public.outbound_send_attempts
for each row execute procedure public.set_updated_at();
