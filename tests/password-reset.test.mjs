/**
 * A reset link resets a password (ORB-104).
 *
 * WHAT WENT WRONG
 *
 * `resetPasswordForEmail` sent the user back to **auth.html**, and auth.html
 * opens with *if there is a user, go to index.html*. Clicking a reset link makes
 * Supabase establish a **recovery session** — the user is, technically, signed
 * in — so that redirect fired and they landed on their dashboard.
 *
 * **Nothing errored.** The email arrived, the link worked, the app said *Reset
 * link sent!*, and the password was never changed. Someone who had genuinely
 * forgotten theirs got in once and was locked out again when the session
 * expired.
 *
 * WHAT THIS SUITE IS
 *
 * Structural. The page is an inline module, like auth.html, so there is no
 * function to import — these read the shipped markup and assert the properties
 * that made the bug possible cannot come back:
 *
 *   1. Recovery is pointed at reset.html, not auth.html.
 *   2. auth.html forwards a recovery landing instead of swallowing it.
 *   3. reset.html never runs the redirect-if-authenticated logic itself.
 *   4. The password form is not the page's default state.
 *
 * It cannot prove the Supabase round trip works. What it can prove is that the
 * wiring which broke it is gone, and that is the part that regressed silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const auth = readFileSync(join(ROOT, "auth.html"), "utf8");
const reset = readFileSync(join(ROOT, "reset.html"), "utf8");
const password = readFileSync(join(ROOT, "js", "password.js"), "utf8");
/**
 * Comments are stripped before any assertion about behaviour, because the first
 * version of this suite failed on the sentence "deliberately no requireAuth()"
 * in reset.html's own header. A test that cannot tell an explanation from a
 * call is testing prose.
 */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/^\s*\*.*$/gm, " ");
const resetCode = code(reset);
const authCode = code(auth);
const dom = new JSDOM(reset);
const $ = (sel) => dom.window.document.querySelector(sel);

group("The email points at a page that can actually reset a password");
{
  const call = /resetPasswordForEmail\([^)]*\{[^}]*\}/s.exec(authCode)?.[0] || "";
  ok("auth.html still sends the email", call.length > 0);
  ok("it redirects to reset.html", /reset\.html/.test(call));
  // The bug, asserted by name so it cannot return under a different variable.
  ok("and NOT back to auth.html", !/authReturnUrl\(\)/.test(call));
}
{
  ok("sign-up confirmation still returns to auth.html",
    /emailRedirectTo:\s*authReturnUrl\(\)/.test(auth)
    || /authReturnUrl\(\)/.test(auth));
  // The two return URLs are different on purpose: a confirmation lands on a
  // sign-in page, a recovery must not.
  ok("so the two return URLs are genuinely different",
    /reset\.html/.test(auth) && /authReturnUrl/.test(auth));
}

group("A recovery landing on auth.html is forwarded, not swallowed");
{
  ok("auth.html detects a recovery landing", /looksLikeRecovery/.test(authCode));
  ok("by both of the shapes Supabase uses",
    /type"\)\s*===\s*"recovery"/.test(auth) && /token_hash/.test(auth));
  ok("and reads the query and the fragment, not just one",
    /window\.location\.search/.test(auth) && /window\.location\.hash/.test(auth));
  ok("it forwards to reset.html", /replace\("reset\.html"/.test(auth));
  ok("carrying the token with it",
    /reset\.html"\s*\+\s*window\.location\.search\s*\+\s*window\.location\.hash/.test(auth));
  // The specific line that caused the bug must now be behind the guard.
  const guarded = /if\s*\(looksLikeRecovery\(\)\)[\s\S]{0,400}?getUser\(\)/.test(authCode);
  ok("the redirect-to-dashboard only runs when this is NOT a recovery", guarded);
}

group("reset.html cannot repeat the mistake");
{
  ok("it does not load the app shell", !/js\/main\.js/.test(resetCode));
  ok("it never calls requireAuth", !/requireAuth/.test(resetCode));
  // The exact behaviour that ate the reset: an authenticated user being sent
  // away. A recovery session IS authenticated, so this page must not do it on
  // load — only after the password has actually been set.
  ok("it does not redirect an authenticated user on load",
    !/getUser\(\)\.then/.test(resetCode));
  const afterSuccess = /updateUser\([\s\S]{0,1200}?index\.html/.test(resetCode);
  ok("the only trip to the dashboard is after a successful update", afterSuccess);
}

group("The form is never the default state");
{
  ok("the checking panel starts visible",
    !$("#checkingPanel").classList.contains("hidden"));
  ok("the password form starts hidden",
    $("#newPasswordForm").classList.contains("hidden"));
  ok("the expired panel starts hidden",
    $("#expiredPanel").classList.contains("hidden"));
  // A form that cannot possibly succeed is worse than a sentence saying why.
  ok("so arriving with no link cannot show a password form",
    /show\(expired\)/.test(reset) || /showExpired\(/.test(reset));
}

group("All three link formats are handled, because Supabase has changed twice");
{
  ok("token_hash, verified explicitly",
    /verifyOtp\(\{\s*token_hash/.test(reset));
  ok("the implicit flow's fragment, polled while the client exchanges it",
    /getSession\(\)/.test(reset) && /attempt/.test(reset));
  ok("and an error, which is what an expired link actually returns",
    /param\("error"\)/.test(reset));
  ok("read from the query and the fragment",
    /window\.location\.search/.test(reset) && /window\.location\.hash/.test(reset));
}

group("The expired state is recoverable where you are standing");
{
  ok("it offers an email field", $("#againEmail"));
  ok("and a resend", $("#againBtn"));
  ok("which requests a link back to this same page",
    /resetPasswordForEmail[\s\S]{0,200}reset\.html/.test(reset));
  ok("with a way back to sign in", $("#backBtn"));
}

group("One minimum length, shared");
{
  ok("password.js owns it", /export const MIN_PASSWORD/.test(password));
  ok("reset.html imports it", /import \{[^}]*MIN_PASSWORD[^}]*\} from "\.\/js\/password\.js"/.test(reset));
  ok("and never hardcodes a number in its place",
    !/at least \d+ characters/i.test(resetCode.replace(/\$\{MIN_PASSWORD\}/g, "")));
  ok("it reuses the strength meter rather than a second one",
    /attachStrengthMeter/.test(reset));
  ok("both fields are checked before the round trip",
    /do not match/.test(reset));
}

group("The page is sound");
{
  const opens = (reset.match(/<div\b/g) || []).length;
  const closes = (reset.match(/<\/div>/g) || []).length;
  eq("every div closes", opens, closes);
  ok("it is not indexable", /name="robots" content="noindex"/.test(reset));
  ok("errors and confirmations are announced",
    dom.window.document.querySelectorAll('[aria-live="polite"]').length >= 4);
  ok("every input has a label",
    [...dom.window.document.querySelectorAll("input")].every((i) =>
      dom.window.document.querySelector(`label[for="${i.id}"]`)));
}

done();
