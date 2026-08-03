-- 0016: app-managed device configuration. Owner edits in Settings; the device
-- pulls it (authenticated by its API key) on every check-in and applies it.
-- OWNER-ONLY RLS — config holds WiFi credentials, unlike the fleet-readable
-- devices status table.

create table if not exists public.device_config (
  device_id uuid primary key references public.devices(id) on delete cascade,
  config jsonb not null default '{}',
  -- expected keys: wifi_ssid, wifi_password, report_interval_s, endpoint_enabled
  updated_at timestamptz not null default now()
);
alter table public.device_config enable row level security;
drop policy if exists "device_config_owner" on public.device_config;
create policy "device_config_owner" on public.device_config
  for all using (
    exists (select 1 from public.devices d
            where d.id = device_id and d.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.devices d
            where d.id = device_id and d.user_id = auth.uid())
  );
