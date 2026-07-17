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

create table if not exists public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  closing_day integer not null check (closing_day between 1 and 31),
  payment_day integer not null check (payment_day between 1 and 31),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'bank' check (type in ('bank', 'wallet', 'cash', 'other')),
  opening_balance numeric(12, 0) not null default 0 check (opening_balance >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.budget_cycles(id) on delete cascade,
  from_account_id uuid not null references public.accounts(id) on delete cascade,
  to_account_id uuid not null references public.accounts(id) on delete cascade,
  date date not null,
  title text not null default '轉帳／儲值',
  amount numeric(12, 0) not null check (amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);

create table if not exists public.income_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.budget_cycles(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  date date not null,
  title text not null,
  income_type text not null default 'other' check (income_type in ('salary', 'mother', 'other')),
  amount numeric(12, 0) not null check (amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monthly_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  amount numeric(12, 0) not null check (amount > 0),
  charge_day integer not null check (charge_day between 1 and 31),
  payment_method text not null default 'cash' check (payment_method in ('cash', 'credit_card')),
  credit_card_id uuid references public.credit_cards(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  is_active boolean not null default true,
  last_recorded_month text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (payment_method = 'credit_card' and credit_card_id is not null and account_id is null)
    or (payment_method = 'cash' and credit_card_id is null)
  )
);

create table if not exists public.installment_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.credit_cards(id) on delete cascade,
  title text not null,
  purchase_date date not null,
  total_amount numeric(12, 0) not null check (total_amount > 0),
  installment_count integer not null check (installment_count > 0),
  first_due_date date not null,
  fee_total numeric(12, 0) not null default 0 check (fee_total >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_card_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null references public.budget_cycles(id) on delete cascade,
  card_id uuid not null references public.credit_cards(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete set null,
  installment_plan_id uuid references public.installment_plans(id) on delete cascade,
  installment_number integer check (installment_number is null or installment_number > 0),
  source_type text not null check (source_type in ('general', 'advance', 'installment', 'opening_bill', 'fee')),
  title text not null,
  charge_date date not null,
  due_date date,
  amount numeric(12, 0) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid')),
  paid_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installment_plan_id, installment_number)
);

alter table public.transactions
  add column if not exists payment_method text not null default 'cash'
    check (payment_method in ('cash', 'credit_card')),
  add column if not exists credit_card_id uuid references public.credit_cards(id) on delete set null,
  add column if not exists account_id uuid references public.accounts(id) on delete set null,
  add column if not exists installment_plan_id uuid references public.installment_plans(id) on delete set null;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'transactions'
      and constraint_name = 'transactions_kind_check'
  ) then
    alter table public.transactions drop constraint transactions_kind_check;
  end if;
end;
$$;

alter table public.transactions
  add constraint transactions_kind_check
  check (kind in ('expense', 'advance', 'installment', 'opening_card_bill', 'card_fee'));

create index if not exists budget_cycles_user_id_idx on public.budget_cycles(user_id);
create index if not exists budget_cycles_active_idx on public.budget_cycles(user_id, is_closed, start_date desc);
create unique index if not exists budget_cycles_one_active_per_user_idx
on public.budget_cycles(user_id)
where is_closed = false;
create index if not exists transactions_user_cycle_idx on public.transactions(user_id, cycle_id, date desc);
create index if not exists reimbursements_user_cycle_idx on public.reimbursements(user_id, cycle_id, status);
create index if not exists credit_cards_user_idx on public.credit_cards(user_id, is_active, name);
create index if not exists accounts_user_idx on public.accounts(user_id, is_active, name);
create index if not exists account_transfers_user_cycle_idx on public.account_transfers(user_id, cycle_id, date desc);
create index if not exists income_records_user_cycle_idx on public.income_records(user_id, cycle_id, date desc);
create index if not exists monthly_subscriptions_user_idx on public.monthly_subscriptions(user_id, is_active, charge_day);
create index if not exists installment_plans_user_card_idx on public.installment_plans(user_id, card_id, is_active);
create index if not exists credit_card_charges_user_cycle_idx on public.credit_card_charges(user_id, cycle_id, status, due_date);
create index if not exists credit_card_charges_card_idx on public.credit_card_charges(user_id, card_id, due_date);

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

drop trigger if exists set_credit_cards_updated_at on public.credit_cards;
create trigger set_credit_cards_updated_at
before update on public.credit_cards
for each row execute function public.set_updated_at();

drop trigger if exists set_accounts_updated_at on public.accounts;
create trigger set_accounts_updated_at
before update on public.accounts
for each row execute function public.set_updated_at();

drop trigger if exists set_account_transfers_updated_at on public.account_transfers;
create trigger set_account_transfers_updated_at
before update on public.account_transfers
for each row execute function public.set_updated_at();

drop trigger if exists set_income_records_updated_at on public.income_records;
create trigger set_income_records_updated_at
before update on public.income_records
for each row execute function public.set_updated_at();

drop trigger if exists set_monthly_subscriptions_updated_at on public.monthly_subscriptions;
create trigger set_monthly_subscriptions_updated_at
before update on public.monthly_subscriptions
for each row execute function public.set_updated_at();

drop trigger if exists set_installment_plans_updated_at on public.installment_plans;
create trigger set_installment_plans_updated_at
before update on public.installment_plans
for each row execute function public.set_updated_at();

drop trigger if exists set_credit_card_charges_updated_at on public.credit_card_charges;
create trigger set_credit_card_charges_updated_at
before update on public.credit_card_charges
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.budget_cycles enable row level security;
alter table public.transactions enable row level security;
alter table public.reimbursements enable row level security;
alter table public.credit_cards enable row level security;
alter table public.accounts enable row level security;
alter table public.account_transfers enable row level security;
alter table public.income_records enable row level security;
alter table public.monthly_subscriptions enable row level security;
alter table public.installment_plans enable row level security;
alter table public.credit_card_charges enable row level security;

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
  and (
    credit_card_id is null
    or exists (
      select 1
      from public.credit_cards
      where credit_cards.id = credit_card_id
        and credit_cards.user_id = (select auth.uid())
    )
  )
  and (
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
  and (
    installment_plan_id is null
    or exists (
      select 1
      from public.installment_plans
      where installment_plans.id = installment_plan_id
        and installment_plans.user_id = (select auth.uid())
    )
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
  and (
    credit_card_id is null
    or exists (
      select 1
      from public.credit_cards
      where credit_cards.id = credit_card_id
        and credit_cards.user_id = (select auth.uid())
    )
  )
  and (
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
  and (
    installment_plan_id is null
    or exists (
      select 1
      from public.installment_plans
      where installment_plans.id = installment_plan_id
        and installment_plans.user_id = (select auth.uid())
    )
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

drop policy if exists "Users can read their credit cards" on public.credit_cards;
create policy "Users can read their credit cards"
on public.credit_cards for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their credit cards" on public.credit_cards;
create policy "Users can insert their credit cards"
on public.credit_cards for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their credit cards" on public.credit_cards;
create policy "Users can update their credit cards"
on public.credit_cards for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their credit cards" on public.credit_cards;
create policy "Users can delete their credit cards"
on public.credit_cards for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their accounts" on public.accounts;
create policy "Users can read their accounts"
on public.accounts for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their accounts" on public.accounts;
create policy "Users can insert their accounts"
on public.accounts for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their accounts" on public.accounts;
create policy "Users can update their accounts"
on public.accounts for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their accounts" on public.accounts;
create policy "Users can delete their accounts"
on public.accounts for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their account transfers" on public.account_transfers;
create policy "Users can read their account transfers"
on public.account_transfers for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their account transfers" on public.account_transfers;
create policy "Users can insert their account transfers"
on public.account_transfers for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.accounts
    where accounts.id = from_account_id
      and accounts.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.accounts
    where accounts.id = to_account_id
      and accounts.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can update their account transfers" on public.account_transfers;
create policy "Users can update their account transfers"
on public.account_transfers for update
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
  and exists (
    select 1
    from public.accounts
    where accounts.id = from_account_id
      and accounts.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.accounts
    where accounts.id = to_account_id
      and accounts.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can delete their account transfers" on public.account_transfers;
create policy "Users can delete their account transfers"
on public.account_transfers for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their income records" on public.income_records;
create policy "Users can read their income records"
on public.income_records for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their income records" on public.income_records;
create policy "Users can insert their income records"
on public.income_records for insert
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
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can update their income records" on public.income_records;
create policy "Users can update their income records"
on public.income_records for update
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
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can delete their income records" on public.income_records;
create policy "Users can delete their income records"
on public.income_records for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their monthly subscriptions" on public.monthly_subscriptions;
create policy "Users can read their monthly subscriptions"
on public.monthly_subscriptions for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their monthly subscriptions" on public.monthly_subscriptions;
create policy "Users can insert their monthly subscriptions"
on public.monthly_subscriptions for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and (
    credit_card_id is null
    or exists (
      select 1
      from public.credit_cards
      where credit_cards.id = credit_card_id
        and credit_cards.user_id = (select auth.uid())
    )
  )
  and (
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can update their monthly subscriptions" on public.monthly_subscriptions;
create policy "Users can update their monthly subscriptions"
on public.monthly_subscriptions for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and (
    credit_card_id is null
    or exists (
      select 1
      from public.credit_cards
      where credit_cards.id = credit_card_id
        and credit_cards.user_id = (select auth.uid())
    )
  )
  and (
    account_id is null
    or exists (
      select 1
      from public.accounts
      where accounts.id = account_id
        and accounts.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can delete their monthly subscriptions" on public.monthly_subscriptions;
create policy "Users can delete their monthly subscriptions"
on public.monthly_subscriptions for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their installment plans" on public.installment_plans;
create policy "Users can read their installment plans"
on public.installment_plans for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their installment plans" on public.installment_plans;
create policy "Users can insert their installment plans"
on public.installment_plans for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.credit_cards
    where credit_cards.id = card_id
      and credit_cards.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can update their installment plans" on public.installment_plans;
create policy "Users can update their installment plans"
on public.installment_plans for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.credit_cards
    where credit_cards.id = card_id
      and credit_cards.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can delete their installment plans" on public.installment_plans;
create policy "Users can delete their installment plans"
on public.installment_plans for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their credit card charges" on public.credit_card_charges;
create policy "Users can read their credit card charges"
on public.credit_card_charges for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their credit card charges" on public.credit_card_charges;
create policy "Users can insert their credit card charges"
on public.credit_card_charges for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.budget_cycles
    where budget_cycles.id = cycle_id
      and budget_cycles.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.credit_cards
    where credit_cards.id = card_id
      and credit_cards.user_id = (select auth.uid())
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
  and (
    installment_plan_id is null
    or exists (
      select 1
      from public.installment_plans
      where installment_plans.id = installment_plan_id
        and installment_plans.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can update their credit card charges" on public.credit_card_charges;
create policy "Users can update their credit card charges"
on public.credit_card_charges for update
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
  and exists (
    select 1
    from public.credit_cards
    where credit_cards.id = card_id
      and credit_cards.user_id = (select auth.uid())
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
  and (
    installment_plan_id is null
    or exists (
      select 1
      from public.installment_plans
      where installment_plans.id = installment_plan_id
        and installment_plans.user_id = (select auth.uid())
    )
  )
);

drop policy if exists "Users can delete their credit card charges" on public.credit_card_charges;
create policy "Users can delete their credit card charges"
on public.credit_card_charges for delete
to authenticated
using ((select auth.uid()) = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.user_settings,
  public.budget_cycles,
  public.transactions,
  public.reimbursements,
  public.credit_cards,
  public.accounts,
  public.account_transfers,
  public.income_records,
  public.monthly_subscriptions,
  public.installment_plans,
  public.credit_card_charges
to authenticated;
