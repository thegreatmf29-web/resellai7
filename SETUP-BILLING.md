# Turning on payments

Four things need to exist before Resell.AI can charge anyone: a **database**, an
**email sender**, **Stripe products**, and a **webhook**. Do them in that order —
each one is checkable on its own, so if something breaks you know exactly what.

Everything here has a free tier. Total cost to get started: $0.

---

## 0. Why the database comes first

Render's free plan gives you a filesystem that is **wiped on every restart**, and
the service restarts after 15 minutes of inactivity. Account records written to
disk vanish with it.

That is survivable while you are testing. It is not survivable once somebody has
paid you — they would lose their subscription and you would have charged them for
nothing. The server therefore **refuses to start** if it sees a live Stripe key
(`sk_live_…`) with no `DATABASE_URL`. That check exists so this failure can never
happen quietly.

### Get a free Postgres

Neon is the quickest ([neon.tech](https://neon.tech), no card):

1. Sign up, create a project.
2. Copy the connection string — it looks like
   `postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`
3. In Render → your service → **Environment**, set `DATABASE_URL` to it.

Tables are created automatically on first boot. Nothing else to do.

---

## 1. Email, so login codes arrive

Sign-in is a 6-digit code. Without a mail provider the server prints the code in
its own logs instead — fine for you, useless for a customer.

1. Sign up at [resend.com](https://resend.com) (3,000 emails/month free).
2. Create an API key.
3. Set `RESEND_API_KEY` in Render.
4. Leave `MAIL_FROM` as `Resell.AI <onboarding@resend.dev>` until you verify
   your own domain. Resend's shared sender works immediately but lands in spam
   more often — verify a domain before you push for real signups.

Check the Email line at server startup: it should say `Resend`, not
`console only`.

---

## 2. Stripe products

In the [Stripe dashboard](https://dashboard.stripe.com), keep **Test mode ON**
for now (toggle, top right).

Create two products under **Product catalogue → Add product**:

| Product | Price | Billing |
|---|---|---|
| Resell.AI Starter | 3.99 USD | Recurring, monthly |
| Resell.AI Pro | 9.99 USD | Recurring, monthly |

After saving each one, click into it and copy the **price ID** — it starts with
`price_`, *not* `prod_`. This is the single most common mistake here; a product
ID will fail at checkout with an unhelpful error.

Then in Render set:

```
STRIPE_SECRET_KEY     sk_test_…      (Developers → API keys)
STRIPE_PRICE_STARTER  price_…        (from Starter)
STRIPE_PRICE_PRO      price_…        (from Pro)
```

---

## 3. The webhook

This is what actually flips somebody to a paid plan. Without it, a customer pays
and nothing happens — the money arrives, the app still says Free.

1. Stripe → **Developers → Webhooks → Add endpoint**
2. URL: `https://resellai6.onrender.com/api/stripe/webhook`
3. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Save, then copy the **signing secret** (`whsec_…`) into Render as
   `STRIPE_WEBHOOK_SECRET`.

The server verifies every webhook signature and rejects anything that fails.
That check is not optional decoration: without it, anyone who discovers your
webhook URL could POST a fake "subscription active" event and upgrade themselves
for free.

---

## 4. Test the whole loop

With test mode still on:

1. Open the app, create an account with a real email, confirm the code arrives.
2. Go to **Plan → Get Starter**.
3. Pay with Stripe's test card: `4242 4242 4242 4242`, any future expiry, any CVC.
4. You land back in the app. Within a second or two the plan should read
   **Starter** and your scan allowance should jump to 10.

If it stays on Free: open Stripe → Developers → Webhooks → your endpoint and
look at the delivery attempts. A 400 there means the signing secret is wrong. No
attempt at all means the endpoint URL is wrong.

---

## 5. Going live

Only after step 4 passes end to end:

1. Flip Stripe out of test mode.
2. Complete Stripe's business activation (they need real identity and bank
   details — this is a legal requirement, not a Stripe quirk).
3. Recreate both products in live mode; **live price IDs are different**.
4. Update in Render: `STRIPE_SECRET_KEY` (`sk_live_…`), both price IDs, and
   create a **new live webhook** with its own signing secret.
5. Confirm `DATABASE_URL` is set. The server will refuse to boot otherwise, and
   that refusal is deliberate.

---

## What the plans actually enforce

Limits live on the server, in `accounts.mjs`. The browser is told what the
limits are so the interface can be honest about them, but it is never trusted —
editing anything in devtools buys nothing.

| | Free | Starter $3.99 | Pro $9.99 |
|---|---|---|---|
| Scans per month | 1 | 10 | 100 |
| Automatic eBay listing | — | yes | yes |
| Inventory | — | yes | yes |

A scan is only counted **after** the analysis succeeds, so a timeout or a
malformed response never costs somebody one of their scans.

Allowances reset every 30 days from the day that person subscribed, not on the
1st of the month — otherwise anyone subscribing on the 28th would get a near
instant reset.

To change any of this, edit the `PLANS` object at the top of
`accounts.mjs`. Changing a price there does **not** change what Stripe
charges — update the price in Stripe too, or the two will disagree.

---

## Costs to keep an eye on

Each scan costs you roughly a cent in Anthropic credit. At $3.99 for 10 scans
your margin is comfortable; at $9.99 for 100 scans a user who genuinely burns
all 100 costs you about $1. Fine — but `DAILY_SCAN_CEILING` in Render is the
backstop that stops a bug or a bot emptying your Anthropic balance overnight.
Leave it set.
