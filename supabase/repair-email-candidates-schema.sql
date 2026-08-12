alter table public.email_transaction_candidates
  add column if not exists candidate_kind text not null default 'purchase',
  add column if not exists due_date date;

notify pgrst, 'reload schema';
