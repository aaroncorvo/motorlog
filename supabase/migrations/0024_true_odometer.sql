-- 0024: true odometer over OBD (firmware ml-0.5).
-- The device reads the real odometer (SAE PID 01A6 on 2019+ vehicles, or the
-- Toyota/Lexus combination-meter read 7C0/2128 that Techstream uses) and ships
-- it in the batch header; ingest-telemetry stores it here. When present and
-- fresh, it beats the fill-up-anchored estimate — no more guessing.

alter table public.devices
  add column if not exists odo_km bigint,
  add column if not exists odo_at timestamptz;

create or replace function public.telemetry_odometer(v_id uuid)
returns int language sql stable security definer set search_path = public as $$
  -- A real odometer read (device installed on this vehicle, reported within
  -- 45 days) is authoritative; convert km → miles. Otherwise fall back to the
  -- estimate: latest manual anchor + GPS trip miles since.
  select coalesce(
    (select (d.odo_km / 1.609344)::int from public.devices d
      where d.vehicle_id = v_id and d.odo_km is not null
        and d.odo_at > now() - interval '45 days'
      order by d.odo_at desc limit 1),
    (with anchor as (
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
    ), 0)::int)
  )
$$;
