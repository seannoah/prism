-- PRISM v1 schema, row-level security and the claim function.  Run ONCE in the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).  Idempotent: safe to re-run.
-- Spec: docs/SPEC.md sections 4 and 7.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ tables
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email        text,
  role         text not null default 'coder' check (role in ('admin', 'coder')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  description     text,
  rubric_url      text,
  rubric_text     text,                       -- shown inside the app (kept private; the repo is public)
  form_spec       jsonb not null,             -- [{key,label,type: choice|multi|int|text, options, min, max, required, show_if}]
  target_coverage int  not null default 2,
  calibration_n   int  not null default 0,    -- first N items (by seq) are shown to everyone
  status          text not null default 'open' check (status in ('open', 'closed')),
  created_at      timestamptz not null default now()
);

create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  external_id text not null,                  -- e.g. A0123, matches the KEY files
  display     jsonb not null,                 -- {text, context}: what coders see
  hidden      jsonb,                          -- report ids, LLM labels: never selected by the coder client
  is_gold     boolean not null default false,
  gold_values jsonb,
  seq         int not null,
  unique (project_id, external_id)
);
create index if not exists items_project_seq on public.items (project_id, seq);

create table if not exists public.assignments (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  coder_id    uuid not null references public.profiles(user_id) on delete cascade,
  status      text not null default 'claimed' check (status in ('claimed', 'done', 'skipped')),
  claimed_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '2 hours',
  skip_reason text,
  unique (item_id, coder_id)
);
create index if not exists assignments_coder on public.assignments (coder_id, status);
create index if not exists assignments_item  on public.assignments (item_id, status);

create table if not exists public.annotations (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null unique references public.assignments(id) on delete cascade,
  answers        jsonb not null,             -- ('values' is reserved in some SQL contexts)
  confidence     int,
  notes          text,
  time_spent_s   int not null default 0,
  submitted_at   timestamptz not null default now(),
  revised_answers jsonb,
  revised_at     timestamptz
);

create table if not exists public.sessions (
  id             uuid primary key default gen_random_uuid(),
  coder_id       uuid not null references public.profiles(user_id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  active_seconds int not null default 0
);

create table if not exists public.ping (id int primary key default 1, last timestamptz not null default now());
insert into public.ping (id) values (1) on conflict do nothing;

-- ------------------------------------------------------------------ helpers
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' and p.active from public.profiles p where p.user_id = auth.uid()), false);
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.active from public.profiles p where p.user_id = auth.uid()), false);
$$;

-- ------------------------------------------------------------------ row-level security
alter table public.profiles    enable row level security;
alter table public.projects    enable row level security;
alter table public.items       enable row level security;
alter table public.assignments enable row level security;
alter table public.annotations enable row level security;
alter table public.sessions    enable row level security;
alter table public.ping        enable row level security;

drop policy if exists profiles_read     on public.profiles;
drop policy if exists profiles_admin    on public.profiles;
drop policy if exists projects_read     on public.projects;
drop policy if exists projects_admin    on public.projects;
drop policy if exists items_admin       on public.items;
drop policy if exists assignments_read  on public.assignments;
drop policy if exists assignments_admin on public.assignments;
drop policy if exists annotations_read  on public.annotations;
drop policy if exists annotations_admin on public.annotations;
drop policy if exists sessions_own      on public.sessions;
drop policy if exists ping_read         on public.ping;

-- profiles: everyone sees their own row; admins see all and may edit
create policy profiles_read  on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy profiles_admin on public.profiles for all    to authenticated using (public.is_admin()) with check (public.is_admin());
-- projects: any active user may read (names, form specs, rubric); admins write
create policy projects_read  on public.projects for select to authenticated using (public.is_active_user() or public.is_admin());
create policy projects_admin on public.projects for all    to authenticated using (public.is_admin()) with check (public.is_admin());
-- items: ADMIN ONLY.  Coders never select items; they receive display payloads from the functions below.
create policy items_admin    on public.items    for all    to authenticated using (public.is_admin()) with check (public.is_admin());
-- assignments / annotations: coders read their own; inserts and updates happen only inside the functions
create policy assignments_read  on public.assignments for select to authenticated using (coder_id = auth.uid() or public.is_admin());
create policy assignments_admin on public.assignments for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy annotations_read  on public.annotations for select to authenticated
  using (public.is_admin() or exists (select 1 from public.assignments a where a.id = assignment_id and a.coder_id = auth.uid()));
create policy annotations_admin on public.annotations for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- sessions: own rows
create policy sessions_own on public.sessions for all to authenticated
  using (coder_id = auth.uid() or public.is_admin()) with check (coder_id = auth.uid() or public.is_admin());
-- ping: anyone (keep-alive from GitHub Actions)
create policy ping_read on public.ping for select to anon, authenticated using (true);

-- ------------------------------------------------------------------ the pull queue
create or replace function public.claim_next_item(p_project uuid)
returns table (assignment_id uuid, item_id uuid, external_id text, display jsonb, seq int,
               is_calibration boolean, calibration_n int, target_coverage int)
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_cal    int;
  v_cov    int;
  v_status text;
  v_item   uuid;
  v_assign uuid;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'not an active user';
  end if;
  select p.calibration_n, p.target_coverage, p.status into v_cal, v_cov, v_status from public.projects p where p.id = p_project;
  if v_status is null then
    raise exception 'unknown project';
  end if;

  -- 1. resume an unexpired open claim (page reload, browser crash)
  select a.id, a.item_id into v_assign, v_item
    from public.assignments a join public.items i on i.id = a.item_id
   where a.coder_id = v_uid and a.status = 'claimed' and i.project_id = p_project and a.expires_at > now()
   limit 1;
  if v_assign is not null then
    update public.assignments set expires_at = now() + interval '2 hours' where id = v_assign;
    return query select v_assign, i.id, i.external_id, i.display, i.seq, (i.seq < v_cal), v_cal, v_cov
                   from public.items i where i.id = v_item;
    return;
  end if;
  if v_status <> 'open' then
    return;
  end if;

  -- 2. release this coder's expired claims so the items return to the pool
  delete from public.assignments a using public.items i
   where a.item_id = i.id and i.project_id = p_project and a.coder_id = v_uid
     and a.status = 'claimed' and a.expires_at <= now();

  -- 3. pick: calibration block first (everyone codes it), then the item with the fewest completed
  --    annotations that this coder has never seen, that is not held by an unexpired claim of someone else
  --    beyond the target coverage.  Row lock + skip locked so two coders never race.
  select i.id into v_item
    from public.items i
    left join lateral (
      select count(*) filter (where a.status = 'done')                                  as done_n,
             count(*) filter (where a.status = 'claimed' and a.expires_at > now())      as active_n
        from public.assignments a where a.item_id = i.id) s on true
   where i.project_id = p_project
     and not exists (select 1 from public.assignments a where a.item_id = i.id and a.coder_id = v_uid)
     and (i.seq < v_cal or (s.done_n + s.active_n) < v_cov)
   order by (i.seq < v_cal) desc, s.done_n asc, s.active_n asc, i.seq asc
   limit 1
   for update of i skip locked;
  if v_item is null then
    return;
  end if;

  insert into public.assignments (item_id, coder_id) values (v_item, v_uid) returning id into v_assign;
  return query select v_assign, i.id, i.external_id, i.display, i.seq, (i.seq < v_cal), v_cal, v_cov
                 from public.items i where i.id = v_item;
end $$;

create or replace function public.submit_annotation(p_assignment uuid, p_values jsonb, p_confidence int,
                                                    p_notes text, p_time_spent_s int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_status text; v_project_status text;
begin
  select a.status, p.status into v_status, v_project_status
    from public.assignments a join public.items i on i.id = a.item_id join public.projects p on p.id = i.project_id
   where a.id = p_assignment and a.coder_id = v_uid;
  if v_status is null then raise exception 'not your assignment'; end if;
  if v_status <> 'claimed' then raise exception 'assignment already %', v_status; end if;
  if v_project_status <> 'open' then raise exception 'project is closed'; end if;
  insert into public.annotations (assignment_id, answers, confidence, notes, time_spent_s)
       values (p_assignment, p_values, p_confidence, p_notes, greatest(coalesce(p_time_spent_s, 0), 0))
    returning id into v_id;
  update public.assignments set status = 'done' where id = p_assignment;
  return v_id;
end $$;

create or replace function public.skip_item(p_assignment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to skip'; end if;
  update public.assignments set status = 'skipped', skip_reason = p_reason
   where id = p_assignment and coder_id = auth.uid() and status = 'claimed';
  if not found then raise exception 'not your open assignment'; end if;
end $$;

create or replace function public.revise_annotation(p_annotation uuid, p_values jsonb, p_confidence int, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.annotations n set revised_answers = p_values, revised_at = now(), confidence = p_confidence, notes = p_notes
    from public.assignments a join public.items i on i.id = a.item_id join public.projects p on p.id = i.project_id
   where n.id = p_annotation and n.assignment_id = a.id and a.coder_id = auth.uid() and p.status = 'open';
  if not found then raise exception 'not your annotation, or the project is closed'; end if;
end $$;

create or replace function public.heartbeat(p_session uuid, p_project uuid, p_active_seconds int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_session is null then
    insert into public.sessions (coder_id, project_id) values (auth.uid(), p_project) returning id into v_id;
    return v_id;
  end if;
  update public.sessions set last_seen_at = now(), active_seconds = greatest(coalesce(p_active_seconds, 0), active_seconds),
                             project_id = coalesce(p_project, project_id)
   where id = p_session and coder_id = auth.uid();
  return p_session;
end $$;

create or replace function public.my_progress()
returns table (project_id uuid, project_name text, status text, calibration_n int, target_coverage int,
               n_done bigint, n_skipped bigint, active_seconds bigint, n_items bigint)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.status, p.calibration_n, p.target_coverage,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'skipped'),
         (select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id and s.coder_id = auth.uid()),
         (select count(*) from public.items i where i.project_id = p.id)
    from public.projects p
   where public.is_active_user()
   order by p.created_at;
$$;

create or replace function public.my_recent_annotations(p_project uuid, p_n int default 20)
returns table (annotation_id uuid, external_id text, display jsonb, answers jsonb, revised_answers jsonb,
               confidence int, notes text, submitted_at timestamptz, revised_at timestamptz)
language sql security definer set search_path = public stable as $$
  select n.id, i.external_id, i.display, n.answers, n.revised_answers, n.confidence, n.notes, n.submitted_at, n.revised_at
    from public.annotations n join public.assignments a on a.id = n.assignment_id join public.items i on i.id = a.item_id
   where a.coder_id = auth.uid() and i.project_id = p_project
   order by n.submitted_at desc
   limit greatest(coalesce(p_n, 20), 1);
$$;

create or replace function public.admin_project_stats()
returns table (project_id uuid, name text, status text, n_items bigint, target_coverage int, calibration_n int,
               n_done bigint, n_skipped bigint, n_open_claims bigint, items_at_target bigint, coders_active bigint)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.status, (select count(*) from public.items i where i.project_id = p.id), p.target_coverage, p.calibration_n,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'skipped'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'claimed' and a.expires_at > now()),
         (select count(*) from public.items i where i.project_id = p.id
             and (select count(*) from public.assignments a where a.item_id = i.id and a.status = 'done') >= p.target_coverage),
         (select count(distinct a.coder_id) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id)
    from public.projects p
   where public.is_admin()
   order by p.created_at;
$$;

-- only signed-in users may call the functions
revoke all on function public.claim_next_item(uuid) from public;
revoke all on function public.submit_annotation(uuid, jsonb, int, text, int) from public;
revoke all on function public.skip_item(uuid, text) from public;
revoke all on function public.revise_annotation(uuid, jsonb, int, text) from public;
revoke all on function public.heartbeat(uuid, uuid, int) from public;
revoke all on function public.my_progress() from public;
revoke all on function public.my_recent_annotations(uuid, int) from public;
revoke all on function public.admin_project_stats() from public;
grant execute on function public.claim_next_item(uuid), public.submit_annotation(uuid, jsonb, int, text, int),
      public.skip_item(uuid, text), public.revise_annotation(uuid, jsonb, int, text), public.heartbeat(uuid, uuid, int),
      public.my_progress(), public.my_recent_annotations(uuid, int), public.admin_project_stats(), public.is_admin(),
      public.is_active_user() to authenticated;
grant select on public.ping to anon, authenticated;
