-- =====================================================================
-- 010 — Shared equipment / stations
-- Run in Supabase → SQL Editor AFTER 009. Safe to run again.
--
--  * equipment.shareable — "Can be shared": several jobs on it at the same
--    time are fine, so no "also booked" (double-booking) warning. Default no.
--  * Stations linked to a test area don't use it: a "Simultaneous" area
--    (Quality Check, up to 7 pumps) is always shared — only the area and
--    per-model limits warn; a "One at a time" area (Medicare / Mediflex
--    bench) always warns when jobs overlap. (Decided in the app; no data change.)
-- RLS, the change log and live updates already cover this table.
-- =====================================================================

alter table public.equipment add column if not exists shareable boolean not null default false;

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- Tell the API (PostgREST) about the new column straight away.
notify pgrst, 'reload schema';
