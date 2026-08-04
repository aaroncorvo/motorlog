-- 0022: Family add-on — extra vehicle slots ($12/yr each via Stripe).
-- Commercial leaves self-serve (special license by contact; grant via a
-- provider='comp' subscriptions row). Extra slots ride the family subscription
-- as a second line item; the webhook stores the quantity here.

alter table public.subscriptions
  add column if not exists extra_vehicles int not null default 0;

-- Vehicle cap = tier cap + purchased extras on the active subscription.
create or replace function public.check_vehicle_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare cap int; extra int;
begin
  select max_vehicles into cap from public.plan_limits
    where tier = public.effective_tier(new.user_id);
  select coalesce(extra_vehicles, 0) into extra from public.subscriptions
    where owner_user_id = new.user_id
      and status in ('trialing','active','past_due')
      and current_period_end + make_interval(days => grace_days) > now()
    order by current_period_end desc limit 1;
  if (select count(*) from public.vehicles
        where user_id = new.user_id and archived = false)
     >= coalesce(cap, 2) + coalesce(extra, 0) then
    raise exception 'PLAN_LIMIT_VEHICLES' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Client-readable extras count (members can't read the owner's subscription
-- row directly, but their vehicle gauge should still be right).
create or replace function public.extra_vehicles(owner uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select extra_vehicles from public.subscriptions
    where owner_user_id = owner
      and status in ('trialing','active','past_due')
      and current_period_end + make_interval(days => grace_days) > now()
    order by current_period_end desc limit 1), 0)
$$;
grant execute on function public.extra_vehicles(uuid) to authenticated;
