-- 0020: free tier becomes a 7-day, 1-vehicle trial (full features).
-- Expiry blocks WRITES, never reads. The 0013 beta comp still outranks this,
-- so current users are untouched until launch.

update public.plan_limits
   set max_vehicles = 1, max_members = 0,
       features = '{"ocr": true, "drive_backup": true}'
 where tier = 'free';

insert into public.plan_limits (tier, max_vehicles, max_members, features)
values ('expired', 0, 0, '{"ocr": false, "drive_backup": false}')
on conflict (tier) do update
  set max_vehicles = 0, max_members = 0, features = excluded.features;

-- trial window = 7 days from account creation
create or replace function public.trial_ends_at(owner uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select created_at + interval '7 days' from auth.users where id = owner
$$;

create or replace function public.effective_tier(owner uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select tier from public.subscriptions
      where owner_user_id = owner
        and status in ('trialing','active','past_due')
        and current_period_end + make_interval(days => grace_days) > now()
      order by current_period_end desc limit 1),
    case when now() < public.trial_ends_at(owner) then 'free' else 'expired' end)
$$;

create or replace function public.owner_can_write(owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.effective_tier(owner) <> 'expired'
$$;

-- write-lock for expired accounts on the core record tables
create or replace function public.check_owner_writable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.owner_can_write(new.user_id) then
    raise exception 'TRIAL_EXPIRED' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists fuel_logs_writable on public.fuel_logs;
create trigger fuel_logs_writable before insert on public.fuel_logs
  for each row execute function public.check_owner_writable();
drop trigger if exists service_logs_writable on public.service_logs;
create trigger service_logs_writable before insert on public.service_logs
  for each row execute function public.check_owner_writable();
drop trigger if exists maintenance_items_writable on public.maintenance_items;
create trigger maintenance_items_writable before insert on public.maintenance_items
  for each row execute function public.check_owner_writable();
