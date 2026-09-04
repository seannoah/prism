-- PRISM v1.1: per-project roster (launcher), instructions + training gate, invite/recovery support.
-- Run ONCE in the Supabase SQL editor after 001_init.sql.  Idempotent.

-- ------------------------------------------------------------------ schema additions
alter table public.projects add column if not exists instructions_text text;
alter table public.projects add column if not exists training_required boolean not null default true;
alter table public.items    add column if not exists is_training boolean not null default false;
alter table public.items    add column if not exists explanation text;      -- shown after a training answer

create table if not exists public.project_members (
  project_id       uuid not null references public.projects(id) on delete cascade,
  user_id          uuid not null references public.profiles(user_id) on delete cascade,
  granted_at       timestamptz not null default now(),
  training_done_at timestamptz,
  primary key (project_id, user_id)
);

create table if not exists public.training_answers (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  item_id     uuid not null references public.items(id) on delete cascade,
  answers     jsonb not null,
  matches_key boolean,
  answered_at timestamptz not null default now()
);
create index if not exists training_answers_user on public.training_answers (project_id, user_id);

alter table public.project_members  enable row level security;
alter table public.training_answers enable row level security;
drop policy if exists members_read  on public.project_members;
drop policy if exists members_admin on public.project_members;
drop policy if exists training_read on public.training_answers;
drop policy if exists training_admin on public.training_answers;
create policy members_read  on public.project_members for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy members_admin on public.project_members for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy training_read on public.training_answers for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy training_admin on public.training_answers for all  to authenticated using (public.is_admin()) with check (public.is_admin());

-- projects: coders now see only the projects they were granted
drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using (public.is_admin() or exists (select 1 from public.project_members m where m.project_id = id and m.user_id = auth.uid()));

create or replace function public.is_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = auth.uid());
$$;

-- ------------------------------------------------------------------ launcher
create or replace function public.my_projects()
returns table (project_id uuid, name text, description text, status text, instructions_text text, rubric_text text,
               training_required boolean, training_done_at timestamptz, n_training bigint, n_training_answered bigint,
               n_items bigint, n_done bigint, n_skipped bigint, active_seconds bigint, calibration_n int, target_coverage int)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.description, p.status, p.instructions_text, p.rubric_text, p.training_required, m.training_done_at,
         (select count(*) from public.items i where i.project_id = p.id and i.is_training),
         (select count(distinct t.item_id) from public.training_answers t where t.project_id = p.id and t.user_id = auth.uid()),
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'skipped'),
         (select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id and s.coder_id = auth.uid()),
         p.calibration_n, p.target_coverage
    from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid()
   where public.is_active_user()
   order by p.created_at;
$$;

-- ------------------------------------------------------------------ training
create or replace function public.training_items(p_project uuid)
returns table (item_id uuid, external_id text, display jsonb, seq int, answered boolean)
language sql security definer set search_path = public stable as $$
  select i.id, i.external_id, i.display, i.seq,
         exists (select 1 from public.training_answers t where t.item_id = i.id and t.user_id = auth.uid())
    from public.items i
   where i.project_id = p_project and i.is_training and public.is_member(p_project)
   order by i.seq;
$$;

create or replace function public.training_check(p_item uuid, p_values jsonb)
returns table (gold_values jsonb, explanation text, matches_key boolean)
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_gold jsonb; v_expl text; v_match boolean;
begin
  select i.project_id, i.gold_values, i.explanation into v_project, v_gold, v_expl
    from public.items i where i.id = p_item and i.is_training;
  if v_project is null then raise exception 'not a training item'; end if;
  if not public.is_member(v_project) then raise exception 'not a member of this project'; end if;
  -- "matches" = every key of the gold answer that is a simple scalar agrees (multi-select and notes are not scored)
  select bool_and(coalesce(p_values ->> k, '') = coalesce(v_gold ->> k, '')) into v_match
    from jsonb_object_keys(coalesce(v_gold, '{}'::jsonb)) k
   where jsonb_typeof(v_gold -> k) in ('string', 'number', 'boolean');
  insert into public.training_answers (project_id, user_id, item_id, answers, matches_key)
       values (v_project, auth.uid(), p_item, p_values, v_match);
  return query select v_gold, v_expl, v_match;
end $$;

create or replace function public.training_complete(p_project uuid)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_missing bigint; v_ts timestamptz;
begin
  if not public.is_member(p_project) then raise exception 'not a member of this project'; end if;
  select count(*) into v_missing from public.items i
   where i.project_id = p_project and i.is_training
     and not exists (select 1 from public.training_answers t where t.item_id = i.id and t.user_id = auth.uid());
  if v_missing > 0 then raise exception '% training items not yet answered', v_missing; end if;
  update public.project_members set training_done_at = coalesce(training_done_at, now())
   where project_id = p_project and user_id = auth.uid() returning training_done_at into v_ts;
  return v_ts;
end $$;

-- ------------------------------------------------------------------ the pull queue: membership + training gate, no training items
create or replace function public.claim_next_item(p_project uuid)
returns table (assignment_id uuid, item_id uuid, external_id text, display jsonb, seq int,
               is_calibration boolean, calibration_n int, target_coverage int)
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_cal    int;
  v_cov    int;
  v_status text;
  v_req    boolean;
  v_done   timestamptz;
  v_ntrain bigint;
  v_item   uuid;
  v_assign uuid;
begin
  if v_uid is null or not public.is_active_user() then raise exception 'not an active user'; end if;
  select p.calibration_n, p.target_coverage, p.status, p.training_required into v_cal, v_cov, v_status, v_req
    from public.projects p where p.id = p_project;
  if v_status is null then raise exception 'unknown project'; end if;
  select m.training_done_at into v_done from public.project_members m where m.project_id = p_project and m.user_id = v_uid;
  if not found then raise exception 'not a member of this project'; end if;
  select count(*) into v_ntrain from public.items i where i.project_id = p_project and i.is_training;
  if v_req and v_ntrain > 0 and v_done is null then raise exception 'training not completed'; end if;

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
  if v_status <> 'open' then return; end if;

  delete from public.assignments a using public.items i
   where a.item_id = i.id and i.project_id = p_project and a.coder_id = v_uid
     and a.status = 'claimed' and a.expires_at <= now();

  select i.id into v_item
    from public.items i
    left join lateral (
      select count(*) filter (where a.status = 'done')                                  as done_n,
             count(*) filter (where a.status = 'claimed' and a.expires_at > now())      as active_n
        from public.assignments a where a.item_id = i.id) s on true
   where i.project_id = p_project and not i.is_training
     and not exists (select 1 from public.assignments a where a.item_id = i.id and a.coder_id = v_uid)
     and (i.seq < v_cal or (s.done_n + s.active_n) < v_cov)
   order by (i.seq < v_cal) desc, s.done_n asc, s.active_n asc, i.seq asc
   limit 1
   for update of i skip locked;
  if v_item is null then return; end if;

  insert into public.assignments (item_id, coder_id) values (v_item, v_uid) returning id into v_assign;
  return query select v_assign, i.id, i.external_id, i.display, i.seq, (i.seq < v_cal), v_cal, v_cov
                 from public.items i where i.id = v_item;
end $$;

-- progress / admin stats: members only, training items excluded from item counts
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
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training)
    from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid()
   where public.is_active_user()
   order by p.created_at;
$$;

drop function if exists public.admin_project_stats();   -- return columns changed: Postgres needs a drop first
create or replace function public.admin_project_stats()
returns table (project_id uuid, name text, status text, n_items bigint, target_coverage int, calibration_n int,
               n_done bigint, n_skipped bigint, n_open_claims bigint, items_at_target bigint, coders_active bigint,
               n_members bigint, n_training bigint, n_trained bigint)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.status, (select count(*) from public.items i where i.project_id = p.id and not i.is_training),
         p.target_coverage, p.calibration_n,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'skipped'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'claimed' and a.expires_at > now()),
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training
             and (select count(*) from public.assignments a where a.item_id = i.id and a.status = 'done') >= p.target_coverage),
         (select count(distinct a.coder_id) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id),
         (select count(*) from public.project_members m where m.project_id = p.id),
         (select count(*) from public.items i where i.project_id = p.id and i.is_training),
         (select count(*) from public.project_members m where m.project_id = p.id and m.training_done_at is not null)
    from public.projects p
   where public.is_admin()
   order by p.created_at;
$$;

revoke all on function public.my_projects() from public;
revoke all on function public.training_items(uuid) from public;
revoke all on function public.training_check(uuid, jsonb) from public;
revoke all on function public.training_complete(uuid) from public;
revoke all on function public.is_member(uuid) from public;
grant execute on function public.my_projects(), public.training_items(uuid), public.training_check(uuid, jsonb),
      public.training_complete(uuid), public.is_member(uuid), public.claim_next_item(uuid), public.my_progress(),
      public.admin_project_stats() to authenticated;
