-- Orbit — ORB-76: the three ORB-73 success metrics, re-read
--
-- Paste the whole file into the Supabase SQL editor and run it. It reads, it
-- never writes, and it is safe to run as often as you like.
--
-- WHY IT IS ONE STATEMENT AND NOT SEVERAL
--
-- The Supabase editor shows only the LAST statement's result. The first version
-- of this file ended with a separate context query, so running it returned the
-- context and silently dropped the three metrics — the reading you actually
-- came for. Everything is now a single UNION ALL, so one paste gives one table
-- and nothing can be quietly discarded.
--
-- The three queries are written out separately in the PRD ("Adding a connection
-- you have not spoken to", §3) because each one is explained line by line
-- there. This is the same SQL with the explanations stripped.
--
-- WHAT THEY ARE FOR
--
-- ORB-73 let you add someone you have not spoken to. Before it, the only way to
-- create a contact also logged a conversation, so the app was inventing history
-- on the day you met someone. Metrics 1 and 2 are the direct test of whether
-- that changed. Metric 3 is a proxy for how painful bulk entry is, and it is
-- the one that decides whether ORB-33's bulk paste gets built.
--
-- BASELINE, 13 AUGUST 2026
--
--   1. Contacts with no conversation ................ 1 of 8
--   2. First conversation on the creation day ....... 3 of 7 (42.9%)
--   3. Contacts created on the account's first day .. 1
--
-- Metric 1 should go UP if ORB-73 is being used. Metric 2 should go DOWN.
-- Metric 3 has almost no room to move on one account, and "not enough data" is
-- an honest reading of it — see the risk table in the PRD, which said so before
-- these numbers existed.

-- ── 1. How many people have no conversation logged at all? ──────────────────
-- Up is good: it means people are being added without a conversation being
-- invented for them. coalesce guards rows where the column is NULL rather than
-- an empty array; without it those rows return NULL and are silently skipped.
select '1. no conversation logged'                    as metric,
       count(*) filter (
         where jsonb_array_length(coalesce(interactions, '[]'::jsonb)) = 0
       )::text || ' of ' || count(*)::text            as reading,
       '1 of 8'                                       as baseline_13_aug
  from public.contacts

union all

-- ── 2. Is a conversation invented on the day the contact is created? ────────
-- Down is good. The denominator is contacts that have at least one
-- conversation, so people added with none drop out of it entirely.
select '2. first conversation on creation day',
       coalesce(
         count(*) filter (where earliest = created_day)::text
         || ' of ' || count(*)::text
         || ' — ' || round(100.0 * count(*) filter (where earliest = created_day)
                           / nullif(count(*), 0), 1)::text || '%',
         'no contacts with conversations yet'),
       '3 of 7 — 42.9%'
  from (
    select c.id,
           c.created_at::date      as created_day,
           min((i->>'date')::date) as earliest
      from public.contacts c
      cross join lateral jsonb_array_elements(
        coalesce(c.interactions, '[]'::jsonb)) i
     group by c.id, c.created_at
  ) t

union all

-- ── 3. How many people were added on the account's first day? ───────────────
-- A proxy for how painful bulk entry is. Each account is measured against its
-- own first day, not the whole table's.
select '3. added on the first day',
       count(*)::text,
       '1'
  from public.contacts c
 where c.created_at::date = (
         select min(created_at)::date
           from public.contacts
          where user_id = c.user_id
       )

union all

-- ── Context ─────────────────────────────────────────────────────────────────
-- Not success metrics. These say whether the three above have enough behind
-- them to mean anything, which the PRD's own risk table doubted in advance.
select '— contacts total', count(*)::text, '8'
  from public.contacts
union all
select '— added since 13 Aug',
       count(*) filter (where created_at::date > date '2026-08-13')::text, '—'
  from public.contacts
union all
select '— conversations logged, all time',
       coalesce(sum(jsonb_array_length(coalesce(interactions, '[]'::jsonb))), 0)::text, '—'
  from public.contacts
union all
select '— starred (ORB-93, ORB-57 metric 1)',
       count(*) filter (where starred)::text, '0'
  from public.contacts

 order by 1;
