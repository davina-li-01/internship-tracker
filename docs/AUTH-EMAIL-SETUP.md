# Auth emails — making the confirmation email look like Orbit

The default confirmation email arrives from **Supabase Auth
&lt;noreply@mail.app.supabase.io&gt;**, says "Follow this link to confirm your
user", and carries a *powered by Supabase* footer. A stranger being asked to
click a link in it is being asked to trust a domain they have never heard of,
from a sender that is not the product they just signed up for.

Three separate problems, and they are fixed in three different places.

---

## 1. The copy — free, five minutes, do this now

**Supabase → Authentication → Emails → Templates → Confirm signup**

Subject:

```
Confirm your email for Orbit
```

Body — this is the reminder digest's own design, so the two emails Orbit sends
look like they came from the same product. Same cream card, same orange
wordmark, same 520px column, same type sizes as
`supabase/functions/send-reminders/reminders.ts`:

```html
<div style="margin:0;padding:24px;background:#FAF6F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#FFFCF8;border-radius:16px;padding:28px;">

    <div style="font-size:18px;font-weight:700;color:#EA580C;letter-spacing:-0.01em;">Orbit</div>

    <p style="color:#1C1917;font-size:20px;font-weight:700;line-height:1.3;margin:20px 0 0;">
      Confirm your email
    </p>

    <p style="color:#57534E;font-size:15px;line-height:1.5;margin:12px 0 24px;">
      You just created an Orbit account. One click and you are in.
    </p>

    <a href="{{ .ConfirmationURL }}"
       style="display:inline-block;background:#EA580C;color:#ffffff;text-decoration:none;
              font-size:15px;font-weight:600;padding:12px 22px;border-radius:10px;">
      Confirm my email address
    </a>

    <p style="color:#78716C;font-size:13px;line-height:1.5;margin:24px 0 0;">
      Or paste this into your browser:
    </p>
    <p style="color:#78716C;font-size:12px;line-height:1.5;margin:4px 0 0;word-break:break-all;">
      {{ .ConfirmationURL }}
    </p>

    <div style="border-top:1px solid #EEE8E0;margin:24px 0 0;"></div>

    <p style="color:#A8A29E;font-size:13px;line-height:1.5;margin:16px 0 0;">
      This link expires in 24 hours. If you did not sign up for Orbit, ignore
      this email — nothing will happen.
    </p>

    <p style="color:#A8A29E;font-size:13px;margin:16px 0 0;">
      Orbit · Keep your people in orbit
    </p>

  </div>
</div>
```

Three things earn their place. **The pasteable URL** — a bare link in an
unfamiliar email is exactly what people are trained not to click, and being able
to read where it goes is what makes it clickable. **"If you did not sign up"** is
the line every real confirmation email carries and phishing almost never
bothers with. And **the wordmark at the top**, because the sender line still
says Supabase until §2 is done; the first thing in the body has to say Orbit or
nothing in the email does.

Inline styles and no `<style>` block on purpose: Gmail strips head styles, so
anything not inline is decoration you will not see.

Do the same for **Reset password**. Anything left unedited keeps saying "your
user".

---

## 2. The sender — done 2026-08-11 (ORB-37)

**This is live.** `orbit-networking.com` is verified in Resend and Supabase Auth
sends through it. The rest of this section is the record of how, and what to
repeat if the domain ever changes.

Two traps, both of which cost time here. Namecheap keeps MX under **MAIL
SETTINGS → Custom MX**, not in the HOST RECORDS type dropdown, so it looks like
MX is unsupported. And every row needs its own teal **✓** before **SAVE ALL
CHANGES** — a row left uncommitted is discarded without a warning, which
presents as a domain stuck on Pending.

Verify from outside the UI rather than trusting it:

```
dig +short TXT resend._domainkey.orbit-networking.com @dns1.registrar-servers.com
```

Querying the registrar's own nameserver separates "not saved" from "not
propagated" — they look identical through Google DNS and have different fixes.



Template edits cannot change who it is from. `noreply@mail.app.supabase.io`
stays until Supabase Auth is pointed at your own SMTP, and the *powered by
Supabase* footer belongs to the built-in service — it disappears with it.

**Supabase → Project Settings → Authentication → SMTP Settings**

Resend already sends the reminder digest, so it can send these too:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a Resend API key |
| Sender email | `noreply@orbit-networking.com` |
| Sender name | `Orbit` |

**A domain was required, and not by choice.** Resend's `onboarding@resend.dev`
only delivers to the address that owns the Resend account — fine for testing the
digest against yourself, useless for real users, because their confirmation
email would never arrive.

### Enable it only once Resend says Verified

While custom SMTP is on and failing, **every** signup returns a 500 — not just
your test. That is strictly worse than the built-in sender. If the domain is
still Pending, leave SMTP off.

The Auth log names the cause and the two causes have different fixes.
**Supabase → Logs → Auth Logs**:

- `535 Authentication credentials invalid` — the API key. Username must be the
  literal `resend`; password must be the `re_…` key, whole, no trailing newline.
- `550 … domain is not verified` — DNS. The key is fine; §2 above is not done.

### The no-domain option, rejected deliberately

**Gmail SMTP with an app password** works, lifts the rate limit to Gmail's daily
cap, and costs nothing. It also makes every confirmation email arrive from a
personal address. To someone who knows you that reads as more trustworthy; to a
stranger who signed up from a link it reads as a personal account asking them to
click something, which is the exact shape of the thing they have been told to
distrust. It also puts transactional mail through an account Google can
rate-limit at its discretion.

---

## 3. The rate limit — lifted by §2, kept here as the reason it mattered

Supabase's built-in email service is for development. It is **heavily rate
limited** — a handful of messages per hour across the whole project — and when
you cross the limit it does not queue and retry. **The email is simply never
sent**, while the app tells the user to go and check their inbox.

That is indistinguishable, from the user's side, from the localhost bug: they
sign up, they are told to check their email, nothing arrives.

Custom SMTP replaced that service entirely, so the ceiling no longer applies —
Resend's own limits are orders of magnitude higher. This is why §2 was not
cosmetic. Between the localhost bug and this limit, an unknown number of the
people who tried to sign up before 2026-08-11 never received anything, and
nothing in the app or the logs would have shown it.

---

## Order to do this in

*All three are done as of 2026-08-11. Kept as the sequence to repeat if the
domain or the mail provider ever changes.*

1. Rewrite the templates (§1). Free, immediate, removes the worst of it.
2. Confirm Site URL and Redirect URLs are the deployed origins, not localhost.
   See the commit for ORB-33 — the code fix is useless without them. Redirect
   URLs need the `/**` suffix, or only the bare origin matches and `auth.html`
   falls back to Site URL silently.
3. **ORB-37:** buy and verify a domain, then set custom SMTP (§2). This is what
   fixes the sender, the footer and the rate limit together.

Step 3 is last for a reason and the ordering is not optional: enabling custom
SMTP against an unverified domain replaces a working-but-ugly signup with a
broken one.
