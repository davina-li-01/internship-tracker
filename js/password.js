/**
 * password.js — one place that decides what a good password is.
 *
 * This exists because there were three answers at once. Sign-up hardcoded a
 * six-character minimum in its label and again in its check, Settings asked for
 * eight, and Supabase enforced its own on top — which is how someone ended up
 * facing a 56-character requirement with the form still promising six.
 *
 * SCORED ON LENGTH, NOT CHARACTER CLASSES
 *
 * NIST SP 800-63B advises against mandatory composition rules. "One uppercase,
 * one digit, one symbol" reliably produces P@ssw0rd1: short, predictable, and
 * on every cracking list. Length and unpredictability are what actually cost an
 * attacker time, so that is what is measured and what the advice says.
 *
 * ADVICE, NOT A GATE
 *
 * Nothing here rejects a password above the minimum. Rules that fight people
 * get worked around — written on a sticky note, or one character bumped on
 * every rotation — so the strength meter informs and never blocks.
 *
 * Supabase remains the authority. Its minimum and any character requirements
 * are set in the dashboard, and this must never claim to be stricter than the
 * server, only faster.
 */

/** Floor for instant feedback. Supabase may require more; it must not require less. */
export const MIN_PASSWORD = 8;

/**
 * Passwords at the top of every breach corpus.
 *
 * Leet substitution is stripped before matching, because P@ssw0rd is not a
 * different password from password — it is the one composition rules produce,
 * and crackers expand these substitutions by default.
 */
const NOTORIOUS = /^(password|passwort|qwerty|letmein|welcome|iloveyou|admin|monkey|dragon|abc123|sunshine|princess)/i;

function deLeet(value) {
  return value
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[!1|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t");
}

/**
 * @returns {{pct:number, band:"weak"|"fair"|"good"|"strong", label:string}|null}
 *          null for an empty input, so the meter can stay hidden.
 */
export function scorePassword(password, email = "") {
  const value = String(password || "").trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  const local = String(email || "").split("@")[0].toLowerCase();

  if (value.length < MIN_PASSWORD) {
    return { pct: 15, band: "weak", label: `Too short — ${MIN_PASSWORD} characters minimum` };
  }
  if (local.length > 2 && lower.includes(local)) {
    return { pct: 20, band: "weak", label: "Contains your email — easy to guess" };
  }
  if (/^(.)\1+$/.test(value)) {
    return { pct: 20, band: "weak", label: "One repeated character" };
  }
  if (NOTORIOUS.test(value) || NOTORIOUS.test(deLeet(lower)) || /^\d+$/.test(value)) {
    return { pct: 25, band: "weak", label: "This is on every cracking list" };
  }

  // Distinct characters stand in for unpredictability. Deliberately not dressed
  // up as an entropy figure — a sign-up form cannot know how guessable a
  // passphrase is, and a precise-looking number would only invite trust it has
  // not earned.
  const variety = new Set(lower).size;

  if (value.length >= 20 || (value.length >= 16 && variety >= 10)) {
    return { pct: 100, band: "strong", label: "Strong — this will hold up" };
  }
  if (value.length >= 12) {
    return { pct: 70, band: "good", label: "Good. A few more words would make it strong" };
  }
  return { pct: 45, band: "fair", label: "Fair — short. Try a few words instead" };
}

/**
 * The guidance shown beside the field. Kept here so both forms say the same
 * thing, and kept to two lines: this is a sign-up form, and advice nobody
 * finishes reading is advice nobody follows.
 */
export function passwordAdviceHtml() {
  return '<p class="pw-advice">'
    + '<strong>Length beats complexity.</strong> Four unrelated words like '
    + '<em>copper lantern dusty whale</em> are harder to crack than '
    + '<em>P@ssw0rd!</em> — and easier to remember. Don\'t reuse one from another site.'
    + '</p>';
}

/**
 * Wires a live meter to an input. Returns nothing; the elements do the talking.
 *
 * @param input     the password field
 * @param meter     wrapper holding .pw-meter-fill and .pw-meter-label
 * @param getEmail  read lazily, because the email field is usually typed first
 *                  but can be changed afterwards
 */
export function attachStrengthMeter(input, meter, getEmail = () => "") {
  if (!input || !meter) return;
  const fill = meter.querySelector(".pw-meter-fill");
  const label = meter.querySelector(".pw-meter-label");

  const update = () => {
    const result = scorePassword(input.value, getEmail());
    if (!result) { meter.hidden = true; return; }
    meter.hidden = false;
    fill.style.width = result.pct + "%";
    fill.className = "pw-meter-fill pw-" + result.band;
    // The label carries the meaning. The bar's colour alone would be unreadable
    // to anyone who cannot distinguish red from green.
    label.textContent = result.label;
    label.className = "pw-meter-label pw-text-" + result.band;
  };

  input.addEventListener("input", update);
  update();
}
