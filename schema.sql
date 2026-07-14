create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_mother_support numeric(12, 0) not null default 20000 check (default_mother_support >= 0),
  default_minimum_savings numeric(12, 0) not null default 5000 check (default_minimum_savings >= 0),
  last_salary numeric(12, 0) check (last_salary >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.budget_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  start_date date not null,
  expected_pay_date date not null,
  salary_income numeric(12, 0) not null check (salary_income >= 0),
  mother_support numeric(12, 0) not null default 20000 check (mother_support >= 0),
  minimum_savings numeric(12, 0) not null default 5000 check (minimum_savings >= 0),
  is_closed boolean not null default false,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expected_pay_date >= start_date)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.budget_cycles(id) on delete cascade,
  kind text not null check (kind in ('expense', 'advance')),
  date date not null,
  title text not null default '一般支出',
  amount numeric(12, 0) not null check (amount >= 0),
  gross_amount numeric(12, 0) not null check (gross_amount >= amount),
  participant_count integer check (participant_count is null or participant_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reimbursements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.budget_cycles(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete cascade,
  title text not null default '待收款',
  amount numeric(12, 0) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'received')),
  received_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists budget_cycles_user_id_idx on public.budget_cycles(user_id);
create index if not exists budget_cycles_active_idx on public.budget_cycles(user_id, is_closed, start_date desc);
create unique index if not exists budget_cycles_one_active_per_user_idx
on public.budget_cycles(user_id)
where is_closed = false;
create index if not exists transactions_user_cycle_idx on public.transactions(user_id, cycle_id, date desc);
create index if not exists reimbursements_user_cycle_idx on public.reimbursements(user_id, cycle_id, status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists set_user_settings_updated_at on public.user_settings;
create trigger set_user_settings_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

drop trigger if exists set_budget_cycles_updated_at on public.budget_cycles;
create trigger set_budget_cycles_updated_at
before update on public.budget_cycles
for each row execute function public.set_updated_at();

drop trigger if exists set_transactions_updated_at on public.transactions;
create trigger set_transactions_updated_at
before update on public.transactions
for each row execute function public.set_updated_at();

drop trigger if exists set_reimbursements_updated_at on public.reimbursements;
create trigger set_reimbursements_updated_at
before update on public.reimbursements
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.budget_cycles enable row level security;
alter table public.transactions enable row level security;
alter table public.reimbursements enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "Users can insert their profile" on public.profiles;
create policy "Users can insert their profile"
on public.profiles for insert
to authenticated
with check ((select auth.uid()) = id);

drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "Users can delete their profile" on public.profiles;
create policy "Users can delete their profile"
on public.profiles for delete
to authenticated
using ((select auth.uid()) = id);

drop policy if exists "Users can read their settings" on public.user_settings;
create policy "Users can read their settings"
on public.user_settings for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their settings" on public.user_settings;
create policy "Users can insert their settings"
on public.user_settings for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their settings" on public.user_settings;
create policy "Users can update their settings"
on public.user_settings for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their settings" on public.user_settings;
create policy "Users can delete their settings"
on public.user_settings for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their cycles" on public.budget_cycles;
create policy "Users can read their cycles"
on public.budget_cycles for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their cycles" on public.budget_cycles;
create policy "Users can insert their cycles"
on public.budget_cycles for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their cycles" on public.budget_cycles;
create policy "Users can update their cycles"
on public.budget_cycles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their cycles" on public.budget_cycles;
create policy "Users can delete their cycles"
on public.budget_cycles for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their transactions" on public.transactions;
create policy "Users can read their transactions"
on public.transactions for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their transactions" on public.transactions;
create policy "Users can insert their transactions"
on public.transactions for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can update their transactions" on public.transactions;
create policy "Users can update their transactions"
on public.transactions for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can delete their transactions" on public.transactions;
create policy "Users can delete their transactions"
on public.transactions for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their reimbursements" on public.reimbursements;
create policy "Users can read their reimbursements"
on public.reimbursements for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their reimbursements" on public.reimbursements;
create policy "Users can insert their reimbursements"
on public.reimbursements for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
  and (
    transaction_id is null
    or exists (
      select 1
      from public.transactions
      where transactions.id = transaction_id
        and transactions.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can update their reimbursements" on public.reimbursements;
create policy "Users can update their reimbursements"
on public.reimbursements for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
  and (
    transaction_id is null
    or exists (
      select 1
      from public.transactions
      where transactions.id = transaction_id
        and transactions.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can delete their reimbursements" on public.reimbursements;
create policy "Users can delete their reimbursements"
on public.reimbursements for delete
to authenticated
using ((select auth.uid()) = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.user_settings,
  public.budget_cycles,
  public.transactions,
  public.reimbursements
to authenticated;
