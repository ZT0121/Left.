-- Allow quarterly subscriptions on both existing and new installations.
do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname from pg_constraint
    where conrelid = 'public.monthly_subscriptions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%billing_cycle%'
  loop
    execute format('alter table public.monthly_subscriptions drop constraint %I', constraint_row.conname);
  end loop;
end $$;
alter table public.monthly_subscriptions
  add constraint monthly_subscriptions_billing_cycle_check
    check (billing_cycle in ('monthly', 'quarterly', 'yearly')),
  add constraint monthly_subscriptions_billing_month_check
    check ((billing_cycle = 'monthly' and charge_month is null)
      or (billing_cycle in ('quarterly', 'yearly') and charge_month is not null));
