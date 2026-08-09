/**
 * ORB-15 — upcoming meetings.
 *
 * Nothing here writes to the database, so the failure modes are all display
 * ones: showing a meeting you already had, missing the join link, or losing
 * the talking points that are the whole reason to show it.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.window = {};
globalThis.document = { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } };
const cal = await import("../js/calendar.js");

let pass=0, fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;console.log(`${ok?"  ok":"FAIL"}  ${n}${ok?"":`\n        got  ${JSON.stringify(g)}\n        want ${JSON.stringify(w)}`}`)};
const ok=(n,c)=>eq(n,Boolean(c),true);

const NOW = new Date("2026-08-09T12:00:00Z").getTime();
const inHours = (h) => new Date(NOW + h*3600_000).toISOString();

const marcus = { id:"c1", name:"Marcus Chen", email:"marcus@stripe.com", followUps:[
  { id:"f1", text:"Ask about the platform team move", completed:false },
  { id:"f2", text:"Already covered this", completed:true },
  { id:"f3", text:"Thank them for the Ramp intro", completed:false }
]};
const priya = { id:"c2", name:"Priya R", email:"priya@airtable.com", followUps:[] };
const NET = [marcus, priya];

const ev = (over={}) => ({
  id:"e1", summary:"Coffee with Marcus", status:"confirmed",
  start:{ dateTime: inHours(24) }, end:{ dateTime: inHours(25) },
  attendees:[{ email:"me@x.com", self:true }, { email:"marcus@stripe.com", responseStatus:"accepted" }],
  ...over
});

console.log("\nHow you are meeting");
eq("Google Meet from hangoutLink",
   cal.meetingMedium({ hangoutLink:"https://meet.google.com/abc" }),
   { label:"Google Meet", url:"https://meet.google.com/abc" });
eq("Zoom from a conference entry point",
   cal.meetingMedium({ conferenceData:{ entryPoints:[{ entryPointType:"video", uri:"https://zoom.us/j/123" }] } }),
   { label:"Zoom", url:"https://zoom.us/j/123" });
eq("Teams",
   cal.meetingMedium({ conferenceData:{ entryPoints:[{ entryPointType:"video", uri:"https://teams.microsoft.com/l/x" }] } }),
   { label:"Teams", url:"https://teams.microsoft.com/l/x" });
eq("Google's own name wins when it gives one",
   cal.meetingMedium({ conferenceData:{ conferenceSolution:{ name:"Webex" }, entryPoints:[{ entryPointType:"video", uri:"https://webex.com/x" }] } }),
   { label:"Webex", url:"https://webex.com/x" });
eq("a physical place",
   cal.meetingMedium({ location:"Blue Bottle, 66 Mint St" }),
   { label:"Blue Bottle, 66 Mint St", url:"" });
eq("a bare url in location is still a link",
   cal.meetingMedium({ location:"https://example.com/room" }),
   { label:"Video call", url:"https://example.com/room" });
eq("nothing at all", cal.meetingMedium({}), { label:"No location set", url:"" });

console.log("\nWhat is ahead");
{
  const found = cal.findUpcoming([ev()], NET, NOW);
  eq("the meeting is listed", found.length, 1);
  eq("with the person on it", found[0].people.map(p=>p.name), ["Marcus Chen"]);
  eq("and only the open talking points",
     found[0].people[0].talkingPoints,
     ["Ask about the platform team move", "Thank them for the Ramp intro"]);
}

ok("a meeting that already happened is not 'coming up'",
   cal.findUpcoming([ev({ start:{ dateTime: inHours(-5) }, end:{ dateTime: inHours(-4) } })], NET, NOW).length === 0);
ok("cancelled is excluded", cal.findUpcoming([ev({ status:"cancelled" })], NET, NOW).length === 0);
ok("one you declined is excluded", cal.findUpcoming([ev({
  attendees:[{ email:"me@x.com", self:true, responseStatus:"declined" },
             { email:"marcus@stripe.com" }] })], NET, NOW).length === 0);
ok("a meeting with nobody from the network is excluded",
   cal.findUpcoming([ev({ attendees:[{ email:"stranger@x.com" }] })], NET, NOW).length === 0);

// Unlike logged conversations, a tentative invite is still worth knowing about.
ok("one you have not answered yet still shows", cal.findUpcoming([ev({
  attendees:[{ email:"me@x.com", self:true, responseStatus:"needsAction" },
             { email:"marcus@stripe.com", responseStatus:"accepted" }] })], NET, NOW).length === 1);

{
  const found = cal.findUpcoming([
    ev({ id:"late", start:{ dateTime: inHours(72) }, end:{ dateTime: inHours(73) } }),
    ev({ id:"soon", start:{ dateTime: inHours(3) },  end:{ dateTime: inHours(4) } })
  ], NET, NOW);
  eq("soonest first", found.map(f=>f.eventId), ["soon","late"]);
}

console.log("\nThe cache");
{
  store.clear();
  const items = cal.findUpcoming([ev()], NET, NOW);
  cal.cacheUpcoming(items, NOW);
  eq("reads back what was written", cal.readUpcoming(NOW).length, 1);

  // The dashboard renders from cache before any sync runs, so a stale entry
  // must not be shown as though it were still ahead.
  eq("a meeting that has since happened is dropped",
     cal.readUpcoming(NOW + 48*3600_000).length, 0);

  cal.clearUpcoming();
  eq("clearing empties it", cal.readUpcoming(NOW), []);

  store.set("orbit_calendar_upcoming", "not json");
  eq("corrupt cache does not throw", cal.readUpcoming(NOW), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
