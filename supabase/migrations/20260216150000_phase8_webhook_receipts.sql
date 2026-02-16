create table if not exists public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('x')),
  request_id text not null,
  signature_header text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists webhook_receipts_status_created_at_idx
  on public.webhook_receipts (status, created_at asc);

create unique index if not exists webhook_receipts_request_id_idx
  on public.webhook_receipts (request_id);

drop trigger if exists webhook_receipts_set_updated_at on public.webhook_receipts;
create trigger webhook_receipts_set_updated_at
before update on public.webhook_receipts
for each row execute procedure public.set_updated_at();
