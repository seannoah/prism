-- PRISM v1.2: admin dashboard (read views + admin actions as security-definer functions gated by is_admin()),
-- so that roster and project changes work from the browser without the secret key.  Run once after 002.

-- ------------------------------------------------------------------ overview per project
drop function if exists public.admin_overview();
create or replace function public.admin_overview()
returns table (project_id uuid, name text, description text, status text, target_coverage int, calibration_n int,
               training_required boolean, n_items bigint, n_training bigint, n_members bigint, n_trained bigint,
               coverage_hist jsonb, n_done bigint, n_skipped bigint, n_open_claims bigint, items_at_target bigint,
               hours numeric, created_at timestamptz)
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
         p.created_at
    from public.projects p
   where public.is_admin()
   order by p.created_at;
$$;

-- ------------------------------------------------------------------ coders x projects
drop function if exists public.admin_coders();
create or replace function public.admin_coders()
returns table (user_id uuid, display_name text, email text, role text, active boolean, project_id uuid, project_name text,
               member boolean, training_done_at timestamptz, n_done bigint, n_skipped bigint, hours numeric,
               last_seen timestamptz, calibration_coded bigint, calibration_with_key bigint, calibration_agreement numeric)
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
     group by i.project_id, a.coder_id)
  select pr.user_id, pr.display_name, pr.email, pr.role, pr.active, p.id, p.name,
         (m.user_id is not null), m.training_done_at,
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = pr.user_id and a.status = 'done'),
         (select count(*) from public.assignments a join public.items i on i.id = a.item_id where i.project_id = p.id and a.coder_id = pr.user_id and a.status = 'skipped'),
         round((select coalesce(sum(s.active_seconds), 0) from public.sessions s where s.project_id = p.id and s.coder_id = pr.user_id) / 3600.0, 2),
         (select max(s.last_seen_at) from public.sessions s where s.project_id = p.id and s.coder_id = pr.user_id),
         coalesce(c.coded, 0), coalesce(c.with_key, 0), round(c.agreement::numeric, 3)
    from public.profiles pr
    cross join public.projects p
    left join public.project_members m on m.project_id = p.id and m.user_id = pr.user_id
    left join cal c on c.project_id = p.id and c.coder_id = pr.user_id
   where public.is_admin()
   order by pr.display_name, p.created_at;
$$;

-- ------------------------------------------------------------------ calibration / adjudication view
drop function if exists public.admin_calibration_items(uuid);
create or replace function public.admin_calibration_items(p_project uuid)
returns table (item_id uuid, external_id text, seq int, display jsonb, gold_values jsonb, explanation text, answers jsonb)
language sql security definer set search_path = public stable as $$
  select i.id, i.external_id, i.seq, i.display, i.gold_values, i.explanation,
         coalesce((select jsonb_agg(jsonb_build_object('coder', pr.display_name, 'answers', coalesce(n.revised_answers, n.answers),
                                                       'confidence', n.confidence, 'notes', n.notes) order by pr.display_name)
                     from public.assignments a join public.annotations n on n.assignment_id = a.id
                     join public.profiles pr on pr.user_id = a.coder_id
                    where a.item_id = i.id and a.status = 'done'), '[]'::jsonb)
    from public.items i join public.projects p on p.id = i.project_id
   where i.project_id = p_project and not i.is_training and i.seq < p.calibration_n and public.is_admin()
   order by i.seq;
$$;

-- ------------------------------------------------------------------ admin actions
create or replace function public.admin_set_gold(p_item uuid, p_gold jsonb, p_explanation text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.items set gold_values = p_gold, explanation = p_explanation, is_gold = (p_gold is not null) where id = p_item;
  if not found then raise exception 'unknown item'; end if;
end $$;

create or replace function public.admin_grant(p_user uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  insert into public.project_members (project_id, user_id) values (p_project, p_user) on conflict do nothing;
end $$;

create or replace function public.admin_revoke(p_user uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  delete from public.project_members where project_id = p_project and user_id = p_user;
end $$;

create or replace function public.admin_set_project(p_project uuid, p_status text, p_target int, p_calibration int, p_training_required boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.projects
     set status = coalesce(p_status, status),
         target_coverage = coalesce(p_target, target_coverage),
         calibration_n = coalesce(p_calibration, calibration_n),
         training_required = coalesce(p_training_required, training_required)
   where id = p_project;
  if not found then raise exception 'unknown project'; end if;
end $$;

create or replace function public.admin_reset_training(p_user uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  delete from public.training_answers where project_id = p_project and user_id = p_user;
  update public.project_members set training_done_at = null where project_id = p_project and user_id = p_user;
end $$;

create or replace function public.admin_set_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_user = auth.uid() and not p_active then raise exception 'you cannot deactivate yourself'; end if;
  update public.profiles set active = p_active where user_id = p_user;
end $$;

revoke all on function public.admin_overview() from public;
revoke all on function public.admin_coders() from public;
revoke all on function public.admin_calibration_items(uuid) from public;
revoke all on function public.admin_set_gold(uuid, jsonb, text) from public;
revoke all on function public.admin_grant(uuid, uuid) from public;
revoke all on function public.admin_revoke(uuid, uuid) from public;
revoke all on function public.admin_set_project(uuid, text, int, int, boolean) from public;
revoke all on function public.admin_reset_training(uuid, uuid) from public;
revoke all on function public.admin_set_active(uuid, boolean) from public;
grant execute on function public.admin_overview(), public.admin_coders(), public.admin_calibration_items(uuid),
      public.admin_set_gold(uuid, jsonb, text), public.admin_grant(uuid, uuid), public.admin_revoke(uuid, uuid),
      public.admin_set_project(uuid, text, int, int, boolean), public.admin_reset_training(uuid, uuid),
      public.admin_set_active(uuid, boolean) to authenticated;
