-- Orbit — relationship tiers replace the interval as the first decision (ORB-52)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHY
--
-- `follow_up_frequency` asks the user for a number of days. For someone they
-- met once, that is a judgment they have no basis to make, so they pick one to
-- clear the form and the value carries no intent. Worse, the named options stop
-- at quarterly — the two longest rhythms the research says matter most, twice
-- yearly and annually, cannot be expressed at all without the custom field.
--
-- A tier is a question a person can actually answer: what kind of relationship
-- is this? The interval comes along as a default.
--
-- See "User Research: Cadence Structure" in Confluence for the sourcing, and
-- its caveats — the tier thresholds come from secondary coverage of Dunbar
-- rather than the primary papers, and no study was found comparing trigger-based
-- against interval-based prompting head to head.
--
-- THE MODEL
--
--   tier                  default interval
--   inner_circle          30 days
--   mentors_managers      90 days
--   professional_network  180 days
--   met_once              365 days
--   none                  no schedule — a deliberate opt-out, not the default
--
-- `follow_up_frequency` STAYS and remains the effective interval, so every
-- existing health calculation keeps working untouched. Choosing a tier sets it
-- to that tier's default; changing the interval afterwards is the override.
-- Tier is what you pick, interval is what runs.

-- ─── The column ───────────────────────────────────────────────────────────────

alter table public.contacts
  add column if not exists tier text;

comment on column public.contacts.tier is
  'Relationship tier (ORB-52). One of inner_circle, mentors_managers, '
  'professional_network, met_once, none. Sets the default follow_up_frequency; '
  'the interval remains the effective schedule so it can be overridden.';

-- ─── Back-fill from the interval already chosen ───────────────────────────────
--
-- Existing intervals were chosen deliberately and carry real intent, so they are
-- derived from rather than overwritten. Only rows with no tier yet are touched,
-- which is what makes this safe to re-run.
--
--   weekly, biweekly, monthly   →  inner_circle
--   bimonthly, quarterly        →  mentors_managers
--   custom:N                    →  nearest tier by N days
--   none / null                 →  none, preserved as an opt-out

update public.contacts
   set tier = case
     when follow_up_frequency in ('weekly', 'biweekly', 'monthly')
       then 'inner_circle'
     when follow_up_frequency in ('bimonthly', 'quarterly')
       then 'mentors_managers'
     when follow_up_frequency like 'custom:%' then (
       -- Nearest of 30 / 90 / 180 / 365 to the chosen day count. A malformed
       -- suffix falls through to professional_network rather than erroring.
       case
         when coalesce(nullif(regexp_replace(follow_up_frequency, '\D', '', 'g'), ''), '0')::int
              between 1 and 60   then 'inner_circle'
         when coalesce(nullif(regexp_replace(follow_up_frequency, '\D', '', 'g'), ''), '0')::int
              between 61 and 135 then 'mentors_managers'
         when coalesce(nullif(regexp_replace(follow_up_frequency, '\D', '', 'g'), ''), '0')::int
              between 136 and 272 then 'professional_network'
         when coalesce(nullif(regexp_replace(follow_up_frequency, '\D', '', 'g'), ''), '0')::int
              > 272 then 'met_once'
         else 'professional_network'
       end
     )
     else 'none'
   end
 where tier is null;

-- ─── What you should see ──────────────────────────────────────────────────────
-- One row per tier with a count. Every contact should now carry one, and the
-- interval column should be unchanged from before this ran.

select coalesce(tier, '(null — should be none)') as tier,
       count(*)                                   as contacts,
       string_agg(distinct coalesce(follow_up_frequency, 'null'), ', ')
                                                  as intervals_seen
  from public.contacts
 group by tier
 order by case tier
   when 'inner_circle'         then 1
   when 'mentors_managers'     then 2
   when 'professional_network' then 3
   when 'met_once'             then 4
   else 5
 end;
