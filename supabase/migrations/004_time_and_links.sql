-- PRISM v1.2.6 (2026-10-07): time accounting and long items.  Run once in the Supabase SQL editor after 003.  Idempotent.
--
-- 1. heartbeat() also keeps the coder's open claim alive, so an item worked on for more than two hours is not handed to
--    someone else when the page reloads.  (The client-side bug that stopped heartbeats from being sent at all is fixed in app.js.)
-- 2. The per-item clock (annotations.time_spent_s) is reported next to the session clock: item_seconds for coders
--    (my_projects, my_progress), item_hours / wall_hours for the dashboard (admin_overview, admin_coders).

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
  update public.assignments set expires_at = now() + interval '2 hours'
   where coder_id = auth.uid() and status = 'claimed';
  return p_session;
end $$;

drop function if exists public.my_projects();   -- return columns change: Postgres needs a drop first
create or replace function public.my_projects()
returns table (project_id uuid, name text, description text, status text, instructions_text text, rubric_text text,
               training_required boolean, training_done_at timestamptz, n_training bigint, n_training_answered bigint,
               n_items bigint, n_done bigint, n_skipped bigint, active_seconds bigint, calibration_n int, target_coverage int,
               item_seconds bigint)
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
         p.calibration_n, p.target_coverage,
         (select coalesce(sum(n.time_spent_s), 0) from public.annotations n join public.assignments a on a.id = n.assignment_id
            join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = auth.uid())
    from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid()
   where public.is_active_user()
   order by p.created_at;
$$;

drop function if exists public.my_progress();
create or replace function public.my_progress()
returns table (project_id uuid, project_name text, status text, calibration_n int, target_coverage int,
               n_done bigint, n_skipped bigint, active_seconds bigint, n_items bigint, item_seconds bigint)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.status, p.calibration_n, p.target_coverage,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id
           where i.project_id = p.id and a.coder_id = auth.uid() and a.status = 'skipped'),
         (select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id and s.coder_id = auth.uid()),
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training),
         (select coalesce(sum(n.time_spent_s), 0) from public.annotations n join public.assignments a on a.id = n.assignment_id
            join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = auth.uid())
    from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid()
   where public.is_active_user()
   order by p.created_at;
$$;

drop function if exists public.admin_overview();
create or replace function public.admin_overview()
returns table (project_id uuid, name text, description text, status text, target_coverage int, calibration_n int,
               training_required boolean, n_items bigint, n_training bigint, n_members bigint, n_trained bigint,
               coverage_hist jsonb, n_done bigint, n_skipped bigint, n_open_claims bigint, items_at_target bigint,
               hours numeric, created_at timestamptz, item_hours numeric)
language sql security definer set search_path = public stable as $$
  select p.id, p.name, p.description, p.status, p.target_coverage, p.calibration_n, p.training_required,
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training),
         (select count(*) from public.items i where i.project_id = p.id and i.is_training),
         (select count(*) from public.project_members m where m.project_id = p.id),
         (select count(*) from public.project_members m where m.project_id = p.id and m.training_done_at is not null),
         (select coalesce(jsonb_object_agg(k::text, v), '{}'::jsonb) from (
            select d.done_n as k, count(*) as v from (
              select i.id, (select count(*) from public.assignments a where a.item_id = i.id and a.status = 'done') as done_n
                from public.items i where i.project_id = p.id and not i.is_training) d group by d.done_n) h),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'skipped'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.status = 'claimed' and a.expires_at > now()),
         (select count(*) from public.items i where i.project_id = p.id and not i.is_training
             and (select count(*) from public.assignments a where a.item_id = i.id and a.status = 'done') >= p.target_coverage),
         round((select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id) / 3600.0, 2),
         p.created_at,
         round((select coalesce(sum(n.time_spent_s), 0) from public.annotations n join public.assignments a on a.id = n.assignment_id
                  join public.items i on i.id = a.item_id where i.project_id = p.id) / 3600.0, 2)
    from public.projects p
   where public.is_admin()
   order by p.created_at;
$$;

drop function if exists public.admin_coders();
create or replace function public.admin_coders()
returns table (user_id uuid, display_name text, email text, role text, active boolean, project_id uuid, project_name text,
               member boolean, training_done_at timestamptz, n_done bigint, n_skipped bigint, hours numeric,
               last_seen timestamptz, calibration_coded bigint, calibration_with_key bigint, calibration_agreement numeric,
               item_hours numeric, wall_hours numeric)
language sql security definer set search_path = public stable as $$
  with cal as (
    select i.project_id, a.coder_id,
           count(*) as coded,
           count(*) filter (where i.gold_values is not null) as with_key,
           avg(case when i.gold_values is null then null
                    when (select bool_and(coalesce(coalesce(n.revised_answers, n.answers) ->> k, '') = coalesce(i.gold_values ->> k, ''))
                            from jsonb_object_keys(i.gold_values) k
                           where jsonb_typeof(i.gold_values -> k) in ('string', 'number', 'boolean')) then 1.0 else 0.0 end) as agreement
      from public.assignments a join public.items i on i.id = a.item_id join public.projects p on p.id = i.project_id
      join public.annotations n on n.assignment_id = a.id
     where a.status = 'done' and not i.is_training and i.seq < p.calibration_n
     group by i.project_id, a.coder_id),
  tim as (
    select i.project_id, a.coder_id,
           sum(n.time_spent_s) as item_s,
           sum(extract(epoch from (n.submitted_at - a.claimed_at))) as wall_s
      from public.assignments a join public.items i on i.id = a.item_id join public.annotations n on n.assignment_id = a.id
     group by i.project_id, a.coder_id)
  select pr.user_id, pr.display_name, pr.email, pr.role, pr.active, p.id, p.name,
         (m.user_id is not null), m.training_done_at,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = pr.user_id and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = pr.user_id and a.status = 'skipped'),
         round((select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id and s.coder_id = pr.user_id) / 3600.0, 2),
         (select max(s.last_seen_at) from public.sessions s where s.project_id = p.id and s.coder_id = pr.user_id),
         coalesce(c.coded, 0), coalesce(c.with_key, 0), round(c.agreement::numeric, 3),
         round(coalesce(t.item_s, 0) / 3600.0, 2), round(coalesce(t.wall_s, 0)::numeric / 3600.0, 2)
    from public.profiles pr
    cross join public.projects p
    left join public.project_members m on m.project_id = p.id and m.user_id = pr.user_id
    left join cal c on c.project_id = p.id and c.coder_id = pr.user_id
    left join tim t on t.project_id = p.id and t.coder_id = pr.user_id
   where public.is_admin()
   order by pr.display_name, p.created_at;
$$;

revoke all on function public.my_projects() from public;
revoke all on function public.my_progress() from public;
revoke all on function public.admin_overview() from public;
revoke all on function public.admin_coders() from public;
grant execute on function public.heartbeat(uuid, uuid, int), public.my_projects(), public.my_progress(),
      public.admin_overview(), public.admin_coders() to authenticated;
