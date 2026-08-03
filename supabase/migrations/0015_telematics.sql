-- 0015: telematics ingestion — Freematics ONE+ (and future devices) → Supabase.
-- Devices authenticate with a per-device API key (stored hashed); telemetry is
-- written ONLY by the ingest-telemetry edge function (service role). Fleet
-- members read everything through the usual membership policies.

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,  -- fleet owner
  vehicle_id uuid references public.vehicles(id) on delete set null,
  name text not null,
  hardware_id text unique,             -- e.g. Freematics DEVICE ID 'ZKUCAU19'
  api_key_hash text not null,          -- sha256 hex of the device key
  fw_version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.devices enable row level security;
drop policy if exists "devices_fleet_read" on public.devices;
create policy "devices_fleet_read" on public.devices
  for select using (user_id in (select public.accessible_owner_ids()));
-- no insert/update/delete policies: service-role only (provisioning via SQL/function)

create table if not exists public.telemetry (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.devices(id) on delete cascade,
  user_id uuid not null,               -- denormalized fleet owner for cheap RLS
  vehicle_id uuid,
  ts timestamptz not null,
  lat double precision, lon double precision,
  speed_kph real, heading real, hdop real,
  rpm int, coolant_c smallint, fuel_pct real,
  batt_v real, engine_on boolean,
  pids jsonb,
  trip_id bigint
);
create index if not exists telemetry_device_ts_idx on public.telemetry (device_id, ts desc);
create index if not exists telemetry_user_ts_idx on public.telemetry (user_id, ts desc);
alter table public.telemetry enable row level security;
drop policy if exists "telemetry_fleet_read" on public.telemetry;
create policy "telemetry_fleet_read" on public.telemetry
  for select using (user_id in (select public.accessible_owner_ids()));
-- writes: service-role only

create table if not exists public.trips (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  vehicle_id uuid,
  device_id uuid references public.devices(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  start_lat double precision, start_lon double precision,
  end_lat double precision, end_lon double precision,
  distance_km real, max_speed_kph real,
  created_at timestamptz not null default now()
);
create index if not exists trips_user_started_idx on public.trips (user_id, started_at desc);
alter table public.trips enable row level security;
drop policy if exists "trips_fleet_read" on public.trips;
create policy "trips_fleet_read" on public.trips
  for select using (user_id in (select public.accessible_owner_ids()));
-- writes: service-role only (trip detection job comes later)
