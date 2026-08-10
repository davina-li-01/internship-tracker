/**
 * Password guidance.
 *
 * Written after someone hit a 56-character minimum at sign-up while the form
 * promised six. That number came from Supabase, but the reason it went unnoticed
 * is that there were three separate answers in play — sign-up said six, Settings
 * said eight, and the server said something else again.
 *
 * The scoring deliberately ignores character classes. NIST SP 800-63B advises
 * against mandatory composition rules because they produce P@ssw0rd1, so these
 * assert that a long passphrase beats a short cryptic string — the opposite of
 * what most sign-up forms reward.
 */
import { MIN_PASSWORD, scorePassword, passwordAdviceHtml } from "../js/password.js";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const band = (pw, email = "") => scorePassword(pw, email)?.band;

group("The minimum is one number, everywhere");
{
  eq("eight characters", MIN_PASSWORD, 8);
  eq("nothing to say about an empty field", scorePassword(""), null);
  eq("or whitespace", scorePassword("   "), null);
  eq("a short password is weak", band("abc"), "weak");
  ok("and says why", scorePassword("abc").label.includes(String(MIN_PASSWORD)));
}

group("Length beats complexity");
{
  // The assertion that matters. A short cryptic string is what composition
  // rules reward; a passphrase is what actually resists cracking.
  eq("a passphrase scores strong", band("copper lantern dusty whale"), "strong");
  eq("while the classic 'strong' password does not", band("P@ssw0rd"), "weak");
  ok("a passphrase outscores it",
     scorePassword("copper lantern dusty whale").pct > scorePassword("P@ssw0r!1").pct);

  eq("twelve characters is good", band("harbourlight"), "good");
  eq("twenty is strong", band("harbourlightmorning1"), "strong");
  eq("eight is fair — allowed, not encouraged", band("harbours"), "fair");
}

group("Obviously guessable passwords are called out");
{
  eq("the word password", band("password123"), "weak");
  eq("qwerty", band("qwerty12345"), "weak");
  eq("all digits", band("12345678901234"), "weak");
  eq("one repeated character", band("aaaaaaaaaaaa"), "weak");
  eq("your own email address", band("davinali723secret", "davinali723@gmail.com"), "weak");
  ok("and names the reason",
     scorePassword("davinali723secret", "davinali723@gmail.com").label.includes("email"));
}

group("A short email local part does not poison everything");
{
  // "me@x.com" would otherwise match almost any password containing "me".
  eq("two-letter locals are ignored", band("copper lantern dusty whale", "me@x.com"), "strong");
}

group("It advises, it never blocks");
{
  // Every branch returns a score. Nothing here can refuse a password, because
  // rules that fight people get worked around rather than obeyed.
  for (const pw of ["password1", "aaaaaaaa", "12345678", "copper lantern dusty whale"]) {
    ok(`"${pw}" still scores rather than erroring`, Boolean(scorePassword(pw)));
  }
}

group("Every score is renderable");
{
  for (const pw of ["abc", "harbours", "harbourlight", "copper lantern dusty whale"]) {
    const r = scorePassword(pw);
    ok(`"${pw}" has a band, a percentage and a label`,
       r.band && r.pct >= 0 && r.pct <= 100 && r.label.length > 0);
  }
}

group("The advice says the same thing in both forms");
{
  const html = passwordAdviceHtml();
  ok("it leads with length", html.includes("Length beats complexity"));
  ok("shows a passphrase example", html.includes("copper"));
  ok("warns against reuse", html.includes("reuse"));
  ok("and names what not to do instead", html.includes("P@ssw0rd"));
}

done();
