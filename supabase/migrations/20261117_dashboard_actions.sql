-- Dashboard actions: share finding, assign investigation, record edits, data issues.
-- Only the server (service-role key, kept in Vercel env) reads or writes these tables.
-- RLS is on with no policies, so the publishable key cannot touch them.

create table if not exists dataset_manifest (
  version      text primary key,
  startups_n   integer not null,
  decisions_n  integer not null,
  survey_n     integer not null,
  is_current   boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index if not exists dataset_manifest_one_current on dataset_manifest (is_current) where is_current;

create table if not exists allowed_record (
  record_id       text primary key,
  dataset_version text not null references dataset_manifest(version)
);

create table if not exists editable_field (
  field      text primary key,
  min_value  numeric not null,
  max_value  numeric not null,
  unit       text not null,
  check (min_value < max_value)
);

create table if not exists action_log (
  id              bigint generated always as identity primary key,
  action          text not null check (action in ('share_finding','assign_investigation','edit_record','report_issue')),
  dataset_version text not null references dataset_manifest(version),
  context         jsonb not null,
  recipients      text[] not null default '{}',
  subject         text,
  body_text       text,
  preview_hash    text not null,
  resend_id       text,
  status          text not null default 'pending' check (status in ('pending','sent','stored','failed')),
  error           text,
  created_at      timestamptz not null default now()
);
create index if not exists action_log_created on action_log (created_at desc);

create table if not exists record_edits (
  id              bigint generated always as identity primary key,
  record_id       text not null references allowed_record(record_id),
  field           text not null references editable_field(field),
  old_value       numeric,
  new_value       numeric not null,
  reason          text not null check (length(trim(reason)) >= 3),
  dataset_version text not null references dataset_manifest(version),
  action_id       bigint references action_log(id),
  created_at      timestamptz not null default now()
);
create index if not exists record_edits_record on record_edits (record_id, field, created_at desc);

create table if not exists data_issues (
  id              bigint generated always as identity primary key,
  record_id       text references allowed_record(record_id),
  audit_edit_id   bigint references record_edits(id),
  description     text not null check (length(trim(description)) >= 5),
  severity        text not null check (severity in ('low','medium','high')),
  dataset_version text not null references dataset_manifest(version),
  action_id       bigint references action_log(id),
  created_at      timestamptz not null default now(),
  check (record_id is not null or audit_edit_id is not null)
);

-- Writes must target the current dataset version; edits must respect the field range.
create or replace function enforce_current_dataset() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from dataset_manifest where version = new.dataset_version and is_current) then
    raise exception 'dataset_version % is not current; reload the dashboard', new.dataset_version
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function enforce_edit_range() returns trigger
language plpgsql set search_path = public as $$
declare lo numeric; hi numeric;
begin
  select min_value, max_value into lo, hi from editable_field where field = new.field;
  if new.new_value < lo or new.new_value > hi then
    raise exception '% must be between % and %', new.field, lo, hi using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists action_log_current on action_log;
create trigger action_log_current before insert on action_log for each row execute function enforce_current_dataset();
drop trigger if exists record_edits_current on record_edits;
create trigger record_edits_current before insert on record_edits for each row execute function enforce_current_dataset();
drop trigger if exists record_edits_range on record_edits;
create trigger record_edits_range before insert on record_edits for each row execute function enforce_edit_range();
drop trigger if exists data_issues_current on data_issues;
create trigger data_issues_current before insert on data_issues for each row execute function enforce_current_dataset();

alter table dataset_manifest enable row level security;
alter table allowed_record   enable row level security;
alter table editable_field   enable row level security;
alter table action_log       enable row level security;
alter table record_edits     enable row level security;
alter table data_issues      enable row level security;

-- Latest value per record and field, for the dashboard overlay and stale-edit checks.
create or replace view v_latest_edit with (security_invoker = on) as
select distinct on (record_id, field) id, record_id, field, old_value, new_value, reason, dataset_version, created_at
from record_edits
order by record_id, field, created_at desc, id desc;
