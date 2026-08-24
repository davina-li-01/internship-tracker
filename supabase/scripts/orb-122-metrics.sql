-- Orbit — ORB-122: does the talking-points list have a lifecycle, or just labels?
--
-- Paste the whole file into the Supabase SQL editor and run it. It reads, it
-- never writes, and it is safe to run as often as you like.
--
-- WHY IT IS ONE STATEMENT
--
-- The Supabase editor shows only the LAST statement's result. ORB-76's first
-- version ended with a separate context query and silently dropped the three
-- metrics — the reading it was written for. Everything here is one statement:
-- CTEs, then a single UNION ALL. Nothing can be quietly discarded.
--
-- WHAT IT IS FOR
--
-- ORB-121 gave a talking point two facts it did not have — the conversation it
-- came from, and whether one has happened since it was raised. ORB-122 used
-- them to split the list into three groups. This says whether that worked.
--
-- The group that matters is CARRIED OVER: points that were already on the list
-- before your last conversation and are still not ticked. Read it twice, weeks
-- apart. Climbing means the grouping relabelled the pile rather than fixing it.
-- ZERO IS ALSO A FAILURE — some points legitimately outlive a conversation, and
-- a network where none ever do means real intent is being lost somewhere.
--
-- THE DEFINITIONS MIRROR js/main.js EXACTLY, and they have to:
--
--   * a CONVERSATION is an interaction whose type is not 'reached out'. Pressing
--     "Reached out" is you sending a message, not a conversation in which a
--     point could have been raised (ORB-96). Counting it here would retire a
--     talking point for a conversation that never happened.
--   * SAME DAY counts as still to come. `createdAt` is a timestamp and an
--     interaction date is a day, so they cannot be ordered against each other.
--   * NO CONVERSATION EVER means nothing has had its chance, however old it is.
--   * A TIMESTAMP IS UTC AND A DATE IS LOCAL, so the two are converted before
--     they are compared. `createdAt` is written with toISOString; an interaction
--     date comes from a date input. In Pacific/Honolulu — UTC-10, which is where
--     this app is actually being used — anything entered after 2pm is stamped
--     with tomorrow's UTC date, so a plain `left(...,10)` reads the wrong day
--     for half of every day and hides carried-over points. The reader's zone
--     comes from preferences.timezone (migration 009), defaulting to UTC.
--
-- BASELINE, ___ ______ 2026 — fill this in the first time you run it, or the
-- second reading has nothing to be compared against.

-- One row per account, with the zone its dates should be read in.
with zones as (
  select user_id, coalesce(nullif(timezone, ''), 'UTC') as tz
    from public.preferences
),

points as (
  select c.id                                             as contact_id,
         coalesce((f->>'completed')::boolean, false)      as completed,
         -- The local calendar day, not the first ten characters. A malformed or
         -- missing value falls back to the old slice rather than erroring, which
         -- is what js/main.js does too.
         coalesce(
           ((f->>'createdAt')::timestamptz at time zone coalesce(z.tz, 'UTC'))::date::text,
           left(coalesce(f->>'createdAt', ''), 10))       as raised_on,
         nullif(f->>'completedAt', '')                    as completed_at,
         nullif(f->>'sourceInteractionId', '')            as source_id,
         length(coalesce(f->>'text', ''))                 as text_len
    from public.contacts c
    left join zones z on z.user_id = c.user_id
    cross join lateral jsonb_array_elements(coalesce(c.follow_ups, '[]'::jsonb)) f
),

-- The pivot: the last real conversation. Touchpoints are excluded here and
-- nowhere else, which is the single line that keeps this honest.
convos as (
  select c.id                as contact_id,
         max(i->>'date')     as last_convo
    from public.contacts c
    cross join lateral jsonb_array_elements(coalesce(c.interactions, '[]'::jsonb)) i
   where coalesce(i->>'type', '') <> 'reached out'
   group by c.id
),

grouped as (
  select p.*,
         v.last_convo,
         case when p.completed                                then 'ticked'
              when v.last_convo is null                       then 'since'
              when p.raised_on >= v.last_convo                then 'since'
              else                                                 'carried'
         end as grp
    from points p
    left join convos v on v.contact_id = p.contact_id
),

-- Driven off `contacts`, not off `points`: a lateral join over an empty jsonb
-- array yields no rows, so a contact with no talking points would vanish from
-- the denominator and every median would read high.
per_contact as (
  select c.id,
         (select count(*) from points g where g.contact_id = c.id)                    as items,
         (select count(*) from grouped g where g.contact_id = c.id and g.grp <> 'ticked') as live,
         (select count(*) from grouped g where g.contact_id = c.id and g.grp = 'carried') as carried,
         v.last_convo
    from public.contacts c
    left join convos v on v.contact_id = c.id
)

-- ── 1. [PRIMARY] How long is the list on someone you have actually spoken to? ─
select '1. [primary] median list length, contacts with a conversation' as metric,
       coalesce(round(percentile_cont(0.5) within group (order by items)::numeric, 1)::text,
                'nobody has a conversation logged yet')                as reading,
       '<= 4'                                                          as target
  from per_contact
 where last_convo is not null

union all

-- The same median counting only what is still live. If the two diverge the
-- grouping is doing its job: a long list whose live half is short is fine.
select '1b. median UNTICKED length, same contacts',
       coalesce(round(percentile_cont(0.5) within group (order by live)::numeric, 1)::text,
                'nobody has a conversation logged yet'),
       'lower than 1'
  from per_contact
 where last_convo is not null

union all

-- ── 2. [SECONDARY] Are points being ticked at all? ───────────────────────────
-- Trends up. `completedAt` was added the day this file was written, so points
-- ticked before then carry none — the dated half only becomes readable from the
-- second run onward, and reads 0 of N on the first.
select '2. [secondary] points ticked, all time',
       count(*) filter (where grp = 'ticked')::text || ' of ' || count(*)::text
       || coalesce(' - ' || round(100.0 * count(*) filter (where grp = 'ticked')
                                  / nullif(count(*), 0), 1)::text || '%', ''),
       'trends up'
  from grouped

union all

select '2b. of those, ticked since the field existed',
       count(*) filter (where completed_at is not null)::text
       || ' of ' || count(*) filter (where grp = 'ticked')::text,
       'grows from 0'
  from grouped

union all

-- ── 3. [GUARDRAIL] Points that survived a conversation untouched ─────────────
-- DOWN IS GOOD AND ZERO IS BAD. Zero means either everything is being force
-- cleared, or nothing is landing in the group at all and the classification is
-- broken. Both look identical on the profile.
select '3. [guardrail] carried over - survived a conversation untouched',
       count(*) filter (where grp = 'carried')::text
       || case when count(*) filter (where grp = 'carried') = 1 then ' point, on ' else ' points, on ' end
       || (select count(*) from per_contact where carried > 0)::text
       || case when (select count(*) from per_contact where carried > 0) = 1
               then ' contact' else ' contacts' end,
       'trends down, never 0'
  from grouped

union all

-- ── Context ──────────────────────────────────────────────────────────────────
-- Not metrics. These say whether the three above have enough behind them to
-- mean anything.
select '- talking points, all contacts', count(*)::text, '-' from points
union all
select '- raised since the last conversation',
       count(*) filter (where grp = 'since')::text, '-' from grouped
union all
select '- contacts with at least one point',
       count(distinct contact_id)::text, '-' from points
union all
select '- contacts with a conversation logged',
       count(*)::text, '-' from per_contact where last_convo is not null
union all
-- The wall-of-text problem, items 14 and 19: Suggest pasted an entire notes
-- field in as a single talking point, twice. A max in the hundreds means it is
-- still happening and ORB-17 has something to fix.
select '- longest single talking point, characters',
       coalesce(max(text_len)::text, '0'), 'under ~120' from points
union all
select '- points that name the conversation they came from (ORB-121)',
       count(*) filter (where source_id is not null)::text
       || ' of ' || count(*)::text, 'grows from 0'
  from points

 order by 1;
