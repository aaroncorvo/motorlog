-- 0017: trip detection + odometer sync from telemetry.
-- Works with OBD-only data (engine_on / rpm) and enriches with GPS distance
-- when coordinates are present, so it produces useful trips today and better
-- ones once a GPS antenna (or phone GPS over BLE) is feeding positions.

-- Great-circle distance in miles between two points
create or replace function public.haversine_mi(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision language sql immutable as $$
  select 3958.7613 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lon2 - lon1) / 2), 2)
  ))
$$;

alter table public.trips
  add column if not exists sample_count int,
  add column if not exists source text default 'telemetry';
-- distance_km on trips is the canonical store; the UI converts to miles

-- Segment unassigned telemetry into trips. A trip breaks on a >5 minute gap
-- (engine off, parked, or device asleep). Rows already carrying trip_id are
-- left alone, so this is safe to run repeatedly.
create or replace function public.detect_trips()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  cur_trip bigint := null;
  prev_ts timestamptz;
  prev_lat double precision;
  prev_lon double precision;
  prev_device uuid;
  dist double precision := 0;
  maxspd real := 0;
  n int := 0;
  made int := 0;
begin
  for r in
    select * from public.telemetry
    where trip_id is null
      and ts < now() - interval '2 minutes'   -- let the current drive settle
    order by device_id, ts
  loop
    -- start a new trip on device change or a gap longer than 5 minutes
    if cur_trip is null or r.device_id <> prev_device
       or r.ts - prev_ts > interval '5 minutes' then
      -- close the previous one
      if cur_trip is not null then
        update public.trips set
          ended_at = prev_ts, end_lat = prev_lat, end_lon = prev_lon,
          distance_km = case when dist > 0 then dist * 1.609344 else null end,
          max_speed_kph = nullif(maxspd, 0), sample_count = n
        where id = cur_trip;
      end if;
      insert into public.trips (user_id, vehicle_id, device_id, started_at,
                                start_lat, start_lon, source)
        values (r.user_id, r.vehicle_id, r.device_id, r.ts, r.lat, r.lon, 'telemetry')
        returning id into cur_trip;
      made := made + 1;
      dist := 0; maxspd := 0; n := 0;
      prev_lat := null; prev_lon := null;
    end if;

    -- accumulate GPS distance when both ends have a real fix
    if r.lat is not null and prev_lat is not null then
      dist := dist + public.haversine_mi(prev_lat, prev_lon, r.lat, r.lon);
    end if;
    if r.speed_kph is not null and r.speed_kph > maxspd then maxspd := r.speed_kph; end if;

    update public.telemetry set trip_id = cur_trip where id = r.id;

    prev_ts := r.ts; prev_device := r.device_id; n := n + 1;
    if r.lat is not null then prev_lat := r.lat; prev_lon := r.lon; end if;
  end loop;

  if cur_trip is not null then
    update public.trips set
      ended_at = prev_ts, end_lat = prev_lat, end_lon = prev_lon,
      distance_km = case when dist > 0 then dist * 1.609344 else null end,
      max_speed_kph = nullif(maxspd, 0), sample_count = n
    where id = cur_trip;
  end if;

  -- Drop trivial fragments (a single sample, or seconds of idle at startup)
  delete from public.trips
   where sample_count is not null and sample_count < 5
     and coalesce(distance_km, 0) < 0.5;

  return made;
end $$;

-- Odometer sync: telemetry distance since the vehicle's last real anchor
-- (a fuel fill-up or service entry, which carry human-read odometer values)
-- is added to that anchor. GPS drift can never accumulate because every
-- fill-up re-anchors the number.
create or replace function public.telemetry_odometer(v_id uuid)
returns int language sql stable security definer set search_path = public as $$
  with anchor as (
    select greatest(
      coalesce((select max(odometer) from public.fuel_logs where vehicle_id = v_id), 0),
      coalesce((select max(odometer) from public.service_logs where vehicle_id = v_id), 0),
      coalesce((select base_odometer from public.vehicles where id = v_id), 0)
    ) as odo,
    greatest(
      coalesce((select max(filled_at::timestamptz) from public.fuel_logs where vehicle_id = v_id), '1970-01-01'),
      coalesce((select max(serviced_at::timestamptz) from public.service_logs where vehicle_id = v_id), '1970-01-01')
    ) as since
  )
  select (select odo from anchor) + coalesce((
    select sum(distance_km) / 1.609344 from public.trips
     where vehicle_id = v_id and started_at > (select since from anchor)
  ), 0)::int
$$;

-- Run detection every 10 minutes
select cron.schedule('detect-trips', '*/10 * * * *', $$select public.detect_trips()$$)
where not exists (select 1 from cron.job where jobname = 'detect-trips');
