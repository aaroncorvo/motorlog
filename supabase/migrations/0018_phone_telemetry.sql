-- 0018: telemetry can originate from the phone app (BLE dongle + phone GPS),
-- not only from a provisioned hardware device. Phone batches authenticate with
-- the user's own JWT instead of a device API key, so they carry no device_id.

alter table public.telemetry alter column device_id drop not null;
alter table public.telemetry
  add column if not exists source text not null default 'device';  -- 'device' | 'phone'

alter table public.trips
  add column if not exists source_default text;   -- kept for provenance display

-- detect_trips() groups by device_id; phone rows share a null device_id, so
-- segment those per vehicle instead. Same 5-minute gap rule.
create or replace function public.detect_trips()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  cur_trip bigint := null;
  prev_ts timestamptz;
  prev_lat double precision;
  prev_lon double precision;
  prev_key text;
  dist double precision := 0;
  maxspd real := 0;
  n int := 0;
  made int := 0;
begin
  for r in
    select *, coalesce(device_id::text, 'phone:' || coalesce(vehicle_id::text, 'none')) as grp
    from public.telemetry
    where trip_id is null
      and ts < now() - interval '2 minutes'
    order by coalesce(device_id::text, 'phone:' || coalesce(vehicle_id::text, 'none')), ts
  loop
    if cur_trip is null or r.grp <> prev_key
       or r.ts - prev_ts > interval '5 minutes' then
      if cur_trip is not null then
        update public.trips set
          ended_at = prev_ts, end_lat = prev_lat, end_lon = prev_lon,
          distance_km = case when dist > 0 then dist * 1.609344 else null end,
          max_speed_kph = nullif(maxspd, 0), sample_count = n
        where id = cur_trip;
      end if;
      insert into public.trips (user_id, vehicle_id, device_id, started_at,
                                start_lat, start_lon, source, source_default)
        values (r.user_id, r.vehicle_id, r.device_id, r.ts, r.lat, r.lon,
                'telemetry', r.source)
        returning id into cur_trip;
      made := made + 1;
      dist := 0; maxspd := 0; n := 0;
      prev_lat := null; prev_lon := null;
    end if;

    if r.lat is not null and prev_lat is not null then
      dist := dist + public.haversine_mi(prev_lat, prev_lon, r.lat, r.lon);
    end if;
    if r.speed_kph is not null and r.speed_kph > maxspd then maxspd := r.speed_kph; end if;

    update public.telemetry set trip_id = cur_trip where id = r.id;

    prev_ts := r.ts; prev_key := r.grp; n := n + 1;
    if r.lat is not null then prev_lat := r.lat; prev_lon := r.lon; end if;
  end loop;

  if cur_trip is not null then
    update public.trips set
      ended_at = prev_ts, end_lat = prev_lat, end_lon = prev_lon,
      distance_km = case when dist > 0 then dist * 1.609344 else null end,
      max_speed_kph = nullif(maxspd, 0), sample_count = n
    where id = cur_trip;
  end if;

  delete from public.trips
   where sample_count is not null and sample_count < 5
     and coalesce(distance_km, 0) < 0.5;

  return made;
end $$;
