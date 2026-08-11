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

Body:

```html
<h2>Confirm your email</h2>

<p>You just created an Orbit account. One click and you are in.</p>

<p><a href="{{ .ConfirmationURL }}">Confirm my email address</a></p>

<p>Or paste this into your browser:<br>
<span style="color:#555">{{ .ConfirmationURL }}</span></p>

<p style="color:#555;font-size:13px">
  This link expires in 24 hours. If you did not sign up for Orbit, you can
  ignore this email and nothing will happen.
</p>

<p style="color:#555;font-size:13px">— Orbit · Keep your people in orbit</p>
```

Two things earn their place. **The pasteable URL** matters because a bare link
in an unfamiliar email is the thing people are told never to click — seeing
where it goes is what makes it clickable. **"If you did not sign up"** is the
line every legitimate confirmation email has and every phishing one omits.

Do the same for **Reset password** and **Magic link** if you ever enable it.
Whatever is left unedited keeps saying "your user".

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
