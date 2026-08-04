-- 0021: tier sizing so Individual doesn't cannibalize Family.
-- Individual = solo account, 2 vehicles (same phone login on multiple devices).
-- Family = 5 vehicles + 5 invited drivers (6 people total).
-- Applied directly via REST 2026-08-04; this file is the record for fresh installs.
update public.plan_limits set max_vehicles = 2, max_members = 0 where tier = 'individual';
update public.plan_limits set max_vehicles = 5, max_members = 5 where tier = 'family';
