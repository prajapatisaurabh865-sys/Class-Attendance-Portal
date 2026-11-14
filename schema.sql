-- ==================================================================
--  ATTENDANCE MANAGER — SUPABASE SCHEMA  (v2)
-- ==================================================================
-- Run this in Supabase (safe to run again on an existing database —
-- it only adds what is missing and keeps all your data): Dashboard → SQL Editor → New query →
-- paste this whole file → Run.
--
-- Design notes:
-- * Dates use a real Postgres `date` column — no more of the Google
--   Sheets "auto-converts to a Date cell and shifts by a day" bug.
-- * The `users` table (which holds password hashes) is NOT directly
--   readable/writable by the app's public key — all access to it
--   goes through the functions below, which run with elevated
--   privileges and never return a password hash to the client.
-- * Every other table (batches, subjects, students, attendance,
--   config) allows open read/write via the app's public "anon" key,
--   same trust level as the previous Apps Script version had (that
--   version also just trusted whatever role the client claimed to
--   be — this isn't a step down in security, just an honest port of
--   the same model). If you later want real per-teacher enforcement,
--   Supabase Auth + row-level policies keyed to auth.uid() is the
--   next step up — ask and this can be added.

create extension if not exists pgcrypto;

-- ---------------- TABLES ----------------

create table if not exists batches (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  description text default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists subjects (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  batch_id uuid references batches(id) on delete cascade,
  active boolean not null default true
);

create table if not exists students (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  roll_no text default '',
  batch_id uuid references batches(id) on delete set null,
  phone text default '',
  email text default '',
  parent_phone text default '',
  admission_date date,
  active boolean not null default true
);

create table if not exists attendance (
  id uuid primary key default extensions.gen_random_uuid(),
  date date not null,
  batch_id uuid references batches(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  status text not null,          -- 'Present' | 'Absent' | 'Late'
  marked_by text default '',
  remark text default '',
  reason text default '',
  color text default '',         -- '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'
  created_at timestamptz not null default now()
);

create table if not exists config (
  key text primary key,
  value text
);

create table if not exists users (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null default 'Teacher',   -- 'Admin' | 'Teacher'
  assigned_batch_ids text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------- UPGRADES (safe to re-run any number of times) ----------------
-- v2: closed batches, discontinued students, role-based permissions.

alter table batches  add column if not exists closed boolean not null default false;
alter table batches  add column if not exists closed_at date;

alter table students add column if not exists discontinued boolean not null default false;
alter table students add column if not exists discontinued_at date;
alter table students add column if not exists discontinue_reason text default '';

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'users' and column_name = 'permissions') then
    alter table users add column permissions text[] not null default '{}';
    -- existing teachers keep exactly the access they had before
    update users set permissions = array['dashboard','mark','records','calling','reports'] where role = 'Teacher';
  end if;
end $$;

-- v3: Holiday / Class Cancelled / No Class days (kept out of attendance so they never affect percentages)
create table if not exists class_off (
  id uuid primary key default extensions.gen_random_uuid(),
  date date not null,
  batch_id uuid references batches(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  type text not null,            -- 'Holiday' | 'Class Cancelled' | 'No Class'
  remark text default '',
  marked_by text default '',
  created_at timestamptz not null default now()
);
create unique index if not exists uq_class_off_slot on class_off (batch_id, subject_id, date);
alter table class_off enable row level security;
drop policy if exists "public read/write class_off" on class_off;
create policy "public read/write class_off" on class_off for all using (true) with check (true);

-- ---------------- INDEXES ----------------

create index if not exists idx_subjects_batch on subjects(batch_id);
create index if not exists idx_students_batch on students(batch_id);
create index if not exists idx_attendance_lookup on attendance(batch_id, subject_id, date);
create index if not exists idx_attendance_student on attendance(student_id);
create index if not exists idx_attendance_date on attendance(date);

-- One attendance row per student per class slot per day. This is what makes
-- re-importing the same CSV safe (duplicates are skipped instead of doubling).
-- Any exact duplicates already present are removed first so the index can be built.
delete from attendance a using attendance b
  where a.ctid < b.ctid and a.student_id = b.student_id and a.subject_id = b.subject_id and a.date = b.date;
create unique index if not exists uq_attendance_slot on attendance (student_id, subject_id, date);

-- ---------------- ROW LEVEL SECURITY ----------------

alter table batches enable row level security;
alter table subjects enable row level security;
alter table students enable row level security;
alter table attendance enable row level security;
alter table config enable row level security;
alter table users enable row level security;

-- Open read/write for the app's public key on the non-sensitive tables.
drop policy if exists "public read/write batches" on batches;
drop policy if exists "public read/write subjects" on subjects;
drop policy if exists "public read/write students" on students;
drop policy if exists "public read/write attendance" on attendance;
drop policy if exists "public read/write config" on config;

create policy "public read/write batches" on batches for all using (true) with check (true);
create policy "public read/write subjects" on subjects for all using (true) with check (true);
create policy "public read/write students" on students for all using (true) with check (true);
create policy "public read/write attendance" on attendance for all using (true) with check (true);
create policy "public read/write config" on config for all using (true) with check (true);
-- Deliberately NO policy on `users` — the public key gets zero direct
-- access to it. All access happens through the SECURITY DEFINER
-- functions below, which bypass RLS internally but never leak a hash.

-- ---------------- AUTH FUNCTIONS ----------------
-- These run as their owner (a privileged role), not as the caller, so they
-- can read/write `users` despite it having no RLS policy for the public key.
-- Roles: 'Admin' | 'Teacher' | 'Tele Caller' | 'Floor Incharge'.
-- `permissions` is the list of things a non-admin may use (admins always get everything).

create or replace function rpc_login(p_username text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u users%rowtype;
begin
  select * into u from users where lower(username) = lower(trim(p_username)) and active = true limit 1;
  if not found then
    return json_build_object('error', 'No active account with that username.');
  end if;
  if u.password_hash != encode(extensions.digest(p_password, 'sha256'), 'hex') then
    return json_build_object('error', 'Incorrect password.');
  end if;
  return json_build_object(
    'id', u.id, 'name', u.name, 'username', u.username, 'role', u.role,
    'assignedBatchIds', coalesce(u.assigned_batch_ids, array[]::text[]),
    'permissions', coalesce(u.permissions, array[]::text[])
  );
end;
$$;

-- Used on page refresh to keep a saved login valid (and pick up role / access changes).
create or replace function rpc_get_session_user(p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  u users%rowtype;
begin
  select * into u from users where id = p_user_id and active = true;
  if not found then
    return json_build_object('error', 'This account is no longer active.');
  end if;
  return json_build_object(
    'id', u.id, 'name', u.name, 'username', u.username, 'role', u.role,
    'assignedBatchIds', coalesce(u.assigned_batch_ids, array[]::text[]),
    'permissions', coalesce(u.permissions, array[]::text[])
  );
end;
$$;

create or replace function rpc_change_password(p_user_id uuid, p_old_password text, p_new_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_hash text;
begin
  select password_hash into current_hash from users where id = p_user_id;
  if not found then
    return json_build_object('error', 'User not found.');
  end if;
  if current_hash != encode(extensions.digest(p_old_password, 'sha256'), 'hex') then
    return json_build_object('error', 'Current password is incorrect.');
  end if;
  update users set password_hash = encode(extensions.digest(p_new_password, 'sha256'), 'hex') where id = p_user_id;
  return json_build_object('success', true);
end;
$$;

create or replace function rpc_list_users()
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return (
    select coalesce(json_agg(json_build_object(
      'id', id, 'name', name, 'username', username, 'role', role,
      'assignedBatchIds', coalesce(assigned_batch_ids, array[]::text[]),
      'permissions', coalesce(permissions, array[]::text[]), 'active', active
    ) order by created_at), '[]'::json)
    from users
  );
end;
$$;

-- the old (v1) signatures are replaced by the ones below that also take permissions
drop function if exists rpc_create_user(text, text, text, text, text[]);
drop function if exists rpc_update_user(uuid, text, text, text[], boolean, text);

create or replace function rpc_create_user(p_name text, p_username text, p_password text, p_role text, p_assigned_batch_ids text[], p_permissions text[])
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id uuid;
begin
  if exists (select 1 from users where lower(username) = lower(p_username)) then
    return json_build_object('error', 'That username is already taken.');
  end if;
  insert into users (name, username, password_hash, role, assigned_batch_ids, permissions)
  values (p_name, p_username, encode(extensions.digest(coalesce(p_password, 'changeme123'), 'sha256'), 'hex'),
          case when p_role in ('Admin', 'Teacher', 'Tele Caller', 'Floor Incharge') then p_role else 'Teacher' end,
          coalesce(p_assigned_batch_ids, '{}'), coalesce(p_permissions, '{}'))
  returning id into new_id;
  return json_build_object('success', true, 'id', new_id);
end;
$$;

create or replace function rpc_update_user(p_id uuid, p_name text, p_role text, p_assigned_batch_ids text[], p_active boolean, p_new_password text, p_permissions text[])
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update users set
    name = coalesce(p_name, name),
    role = coalesce(case when p_role in ('Admin', 'Teacher', 'Tele Caller', 'Floor Incharge') then p_role else null end, role),
    assigned_batch_ids = coalesce(p_assigned_batch_ids, assigned_batch_ids),
    permissions = coalesce(p_permissions, permissions),
    active = coalesce(p_active, active),
    password_hash = case when p_new_password is not null and p_new_password != ''
                          then encode(extensions.digest(p_new_password, 'sha256'), 'hex') else password_hash end
  where id = p_id;
  if not found then
    return json_build_object('error', 'User not found.');
  end if;
  return json_build_object('success', true);
end;
$$;

create or replace function rpc_delete_user(p_id uuid)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from users where id = p_id;
  return json_build_object('success', true);
end;
$$;

-- ---------------- REPORT FUNCTIONS ----------------
-- Attendance totals are counted inside the database (fast, even with 100k+ rows)
-- instead of downloading every row to the browser first.

create or replace function rpc_student_wise_report(p_batch_id uuid default null, p_from date default null, p_to date default null)
returns json
language sql
stable
as $$
  select coalesce(json_agg(t order by t."percentage", t."studentName"), '[]'::json) from (
    select
      s.id as "studentId",
      s.batch_id as "batchId",
      s.discontinued as "discontinued",
      s.name as "studentName",
      coalesce(s.roll_no, '') as "rollNo",
      count(*)::int as "totalSessions",
      (count(*) filter (where a.status in ('Present', 'Late')))::int as "present",
      (count(*) - count(*) filter (where a.status in ('Present', 'Late')))::int as "absent",
      round((count(*) filter (where a.status in ('Present', 'Late')))::numeric * 100 / nullif(count(*), 0), 1)::float8 as "percentage"
    from attendance a
    join students s on s.id = a.student_id
    where (p_batch_id is null or a.batch_id = p_batch_id)
      and (p_from is null or a.date >= p_from)
      and (p_to is null or a.date <= p_to)
    group by s.id, s.name, s.roll_no
  ) t;
$$;

create or replace function rpc_batch_wise_report(p_batch_id uuid default null, p_from date default null, p_to date default null)
returns json
language sql
stable
as $$
  select coalesce(json_agg(t order by t."date" desc, t."batchName", t."subjectName"), '[]'::json) from (
    select
      a.date::text as "date",
      a.batch_id as "batchId",
      b.name as "batchName",
      sj.name as "subjectName",
      (count(*) filter (where a.status = 'Present'))::int as "present",
      (count(*) filter (where a.status = 'Absent'))::int as "absent",
      (count(*) filter (where a.status = 'Late'))::int as "late",
      count(*)::int as "total"
    from attendance a
    join batches b on b.id = a.batch_id
    join subjects sj on sj.id = a.subject_id
    where (p_batch_id is null or a.batch_id = p_batch_id)
      and (p_from is null or a.date >= p_from)
      and (p_to is null or a.date <= p_to)
    group by a.date, a.batch_id, b.name, sj.name
  ) t;
$$;

-- ---------------- SEED DATA ----------------
-- Default admin login: username "admin", password "admin123".
-- Change it from Settings after your first login.

insert into users (name, username, password_hash, role)
select 'Administrator', 'admin', encode(extensions.digest('admin123', 'sha256'), 'hex'), 'Admin'
where not exists (select 1 from users where username = 'admin');

insert into config (key, value) values ('InstituteName', 'My Coaching Institute')
  on conflict (key) do nothing;
insert into config (key, value) values ('DefaulterThreshold', '75')
  on conflict (key) do nothing;
