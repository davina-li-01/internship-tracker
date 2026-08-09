import { loadMain } from "./helpers/load-main.mjs";
const { normalizeContact, normalizeInteraction, calculateNextReminder, firstDeadlineFor, getHealth, conversationPreview } = await loadMain();
// The conversation logger's merge rules, exercised the way the form does it.

let pass=0, fail=0;
const check=(l,a,e)=>{const ok=JSON.stringify(a)===JSON.stringify(e);
  ok?(pass++,console.log("  pass  "+l)):(fail++,console.log(`  FAIL  ${l}\n        expected ${JSON.stringify(e)}\n        got      ${JSON.stringify(a)}`));};
const daysAgo=(n)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-n);return d.toISOString().slice(0,10);};
const today=()=>new Date().toISOString().slice(0,10);

// Mirrors the widget's submit handler.
function logConversation(existing, { name, role, company, email, when, type, notes, frequency }) {
  const interaction = normalizeInteraction({ date: when, type, notes });
  const merged = [interaction, ...(existing?.interactions || [])].sort((a,b)=>b.date.localeCompare(a.date));
  const wasOff = !existing || !existing.reminderEnabled || existing.followUpFrequency === "none";
  return normalizeContact({
    ...(existing || {}), name, role, company, email,
    dateMet: existing?.dateMet || when,
    interactions: merged,
    lastContacted: merged[0].date,
    followUpFrequency: frequency,
    reminderEnabled: frequency !== "none",
    nextReminder: frequency === "none" ? ""
      : (notes || !wasOff) ? calculateNextReminder(merged[0].date, frequency)
                           : firstDeadlineFor(merged[0].date, frequency)
  });
}

console.log("\n── logging against an existing person ──");
const existing = normalizeContact({
  id: "abc", name: "Claudina Padovani", role: "Product Manager", company: "Turno",
  email: "c@turno.com", dateMet: daysAgo(200), lastContacted: daysAgo(40),
  followUpFrequency: "monthly", reminderEnabled: true,
  interactions: [ normalizeInteraction({ date: daysAgo(40), type: "coffee chat", notes: "First chat" }) ]
});
const updated = logConversation(existing, {
  name: "Claudina Padovani", role: "Product Manager", company: "Turno", email: "c@turno.com",
  when: today(), type: "meeting", notes: "Talked about her new team", frequency: "monthly"
});
check("keeps the same id — no duplicate contact", updated.id, "abc");
check("history grows rather than being replaced", updated.interactions.length, 2);
check("newest conversation is first", updated.interactions[0].notes, "Talked about her new team");
check("older conversation survives", updated.interactions[1].notes, "First chat");
check("lastContacted moves to today", updated.lastContacted, today());
check("dateMet is NOT overwritten", updated.dateMet, daysAgo(200));
check("cadence rolls forward 30 days", updated.nextReminder.slice(0,10), (()=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+30);return d.toISOString().slice(0,10);})());
check("no longer overdue", getHealth(updated).band, "good");

console.log("\n── back-dating a conversation ──");
const backdated = logConversation(existing, {
  name: "Claudina Padovani", role:"", company:"", email:"",
  when: daysAgo(90), type: "email", notes: "Older note", frequency: "monthly"
});
check("still two conversations", backdated.interactions.length, 2);
check("most recent stays on top, not the one just added",
  backdated.interactions[0].date, daysAgo(40));
check("lastContacted reflects the newest, not the entry order",
  backdated.lastContacted, daysAgo(40));

console.log("\n── a brand-new person ──");
const created = logConversation(null, {
  name: "Marcus Chen", role: "Engineer", company: "Stripe", email: "m@stripe.com",
  when: today(), type: "coffee chat", notes: "Met at the meetup", frequency: "monthly"
});
check("gets one conversation", created.interactions.length, 1);
check("dateMet is the conversation date", created.dateMet, today());
check("details captured", [created.role, created.company], ["Engineer","Stripe"]);
check("healthy from the start", getHealth(created).band, "good");

console.log("\n── editing details while logging ──");
const moved = logConversation(existing, {
  name: "Claudina Padovani", role: "Director of Product", company: "Notion",
  email: "c@notion.so", when: today(), type: "meeting", notes: "She moved companies",
  frequency: "monthly"
});
check("role updated", moved.role, "Director of Product");
check("company updated", moved.company, "Notion");
check("email updated", moved.email, "c@notion.so");
check("history still intact", moved.interactions.length, 2);

console.log("\n── cadence changes are respected ──");
const paused = logConversation(existing, {
  name:"Claudina Padovani", role:"", company:"", email:"",
  when: today(), type:"email", notes:"quick note", frequency: "none"
});
check("no cadence clears the deadline", paused.nextReminder, "");
check("and stops being measured", getHealth(paused).scheduled, false);

console.log("\n── preview shows the latest conversation ──");
check("uses newest conversation notes",
  conversationPreview(updated).includes("Talked about her new team"), true);
check("shows the conversation count",
  conversationPreview(updated).includes("2 conversations"), true);
check("empty history renders nothing",
  conversationPreview(normalizeContact({name:"X"})), "");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
