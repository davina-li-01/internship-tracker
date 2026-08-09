-- Orbit — RLS health check
--
-- Run this first whenever a save fails with 403 "new row violates row-level
-- security policy", or whenever data mysteriously reads back empty.
--
-- The failure mode this catches is nasty because it is silent in one direction:
-- a table with RLS enabled and ZERO policies denies everything, but SELECT does
-- not error — it just returns no rows. So the app looks empty rather than
-- broken, and you only find out when a write returns 403.
--
-- This has now cost two debugging sessions: once when every table had wide-open
-- "Allow all (dev)" policies, and once when `preferences` had lost its policy
-- entirely and had been silently unsaveable.
--
-- Read-only. Safe to run any time.

select
  t.tablename,
  c.relrowsecurity                                   as rls_enabled,
  count(p.policyname)                                as policies,
  coalesce(string_agg(p.policyname, ', '), '—')      as policy_names,
  case
    when not c.relrowsecurity          then '⚠️  RLS OFF — every row is readable by anyone with the public key'
    when count(p.policyname) = 0       then '❌ LOCKED — RLS on with no policies. Reads return nothing, writes 403'
    when bool_or(p.qual is null)       then '⚠️  a policy has no USING clause'
    when bool_or(p.with_check is null
                 and p.cmd in ('ALL', 'INSERT', 'UPDATE'))
                                       then '⚠️  a write policy has no WITH CHECK — writes are unchecked'
    when bool_or('public' = any(p.roles)) then '⚠️  granted to public rather than authenticated'
    else '✅ ok'
  end                                                as verdict
from (values ('contacts'), ('preferences'), ('storage_files')) t(tablename)
join pg_class c
  on c.relname = t.tablename
 and c.relnamespace = 'public'::regnamespace
left join pg_policies p
  on p.tablename = t.tablename
 and p.schemaname = 'public'
group by t.tablename, c.relrowsecurity
order by t.tablename;

-- Anything other than ✅ on all three rows: run supabase/fix-rls.sql, which
-- recreates all three owner-scoped policies.

-- Storage is governed separately — bucket policies live on storage.objects and
-- are not covered above. Zero rows here means uploads fail.
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;
