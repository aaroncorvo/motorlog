-- 0023: hourly CRM sync — push users + plan tags to the MotorLog GHL
-- sub-account via the crm-sync edge function (cron-secret auth, same
-- pattern as the nightly Drive backup).
select cron.unschedule('crm-sync-hourly')
  where exists (select 1 from cron.job where jobname = 'crm-sync-hourly');

select cron.schedule(
  'crm-sync-hourly',
  '17 * * * *',
  $$
  select net.http_post(
    url := 'https://fxycfrtycqxdlhrpfeiv.supabase.co/functions/v1/crm-sync',
    headers := jsonb_build_object(
      'x-cron-secret', 'ca3b6ffaf0dd5dad94b842de207828e36d1bb18faec200d9',
      'content-type', 'application/json'),
    body := '{}'::jsonb)
  $$);
