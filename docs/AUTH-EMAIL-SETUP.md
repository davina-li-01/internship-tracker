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

## 2. The sender — needs a domain (ORB-37)

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
| Sender email | `noreply@yourdomain.com` |
| Sender name | `Orbit` |

**This is blocked on owning a domain, and not by choice.** Resend's
`onboarding@resend.dev` only delivers to the address that owns the Resend
account — fine for testing the digest against yourself, useless for real users,
because their confirmation email would never arrive. So: buy the domain, verify
it in Resend, then fill this in. That is ORB-37, and this is a second reason to
do it beyond spam placement.

### "Should I just set up custom SMTP now?"

Yes — but the button cannot be finished today without a domain, so the order is
domain first, SMTP second. A domain is roughly £10 a year and it unblocks the
sender, the footer and the rate limit in one move.

There is one no-domain option, and it is worth knowing about mainly so you can
reject it deliberately: **Gmail SMTP with an app password**. It works, it lifts
the rate limit to Gmail's much higher daily cap, and it costs nothing. What it
does is make every confirmation email arrive from your personal address. For
someone who knows you that reads as more trustworthy, not less. For a stranger
who signed up from a link it reads as a personal account asking them to click
something, which is the exact shape of the thing they have been told to
distrust. It also puts transactional mail through an account Google can
rate-limit or flag at its discretion.

Use it only if signups are actively failing and the domain is days away.
Otherwise buy the domain — it is the cheaper fix in every sense.

---

## 3. The rate limit — the one that is silently costing you signups

Supabase's built-in email service is for development. It is **heavily rate
limited** — a handful of messages per hour across the whole project — and when
you cross the limit it does not queue and retry. **The email is simply never
sent**, while the app tells the user to go and check their inbox.

That is indistinguishable, from the user's side, from the localhost bug: they
sign up, they are told to check their email, nothing arrives.

Check the current ceiling at **Authentication → Rate Limits**. With real people
signing up, moving to custom SMTP is not cosmetic — it is the difference between
every confirmation arriving and some fraction of them vanishing.

---

## Order to do this in

1. **Now:** rewrite the templates (§1). Free, immediate, removes the worst of it.
2. **Now:** confirm Site URL and Redirect URLs are the deployed origins, not
   localhost. See the commit for ORB-33 — the code fix is useless without them.
3. **ORB-37:** buy and verify a domain, then set custom SMTP (§2). This is what
   fixes the sender, the footer and the rate limit together.

Until step 3, anyone signing up sees a Supabase sender. The template rewrite
makes that survivable; it does not make it good.
