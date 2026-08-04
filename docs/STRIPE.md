# Stripe setup (Phase 1 billing)

Code is deployed; Stripe activates the moment the account-side steps below are done.
Money path: app → `stripe-checkout` edge fn → Stripe-hosted page → `stripe-webhook`
edge fn → `subscriptions` table → `effective_tier()` (migration 0012). Card data
never touches our code or database.

## One-time setup (Aaron)

1. **Create the Stripe account** — dashboard.stripe.com, business name MotorLog.
   Start in **Test mode** for the first end-to-end check.
2. **Create 3 products** (Product catalog → Add product), each with one
   **recurring yearly** price:
   - MotorLog Individual — $24/year
   - MotorLog Family — $48/year
   - MotorLog Extra Vehicle — $12/year (family add-on, quantity = slots)
   Commercial is NOT self-serve — special licensing by contact; grant it with a
   provider='comp' subscriptions row. Copy each **price ID** (`price_…`).
3. **Supabase secrets** (Edge Functions → Secrets):
   - `STRIPE_SECRET_KEY` = sk_… (Developers → API keys)
   - `STRIPE_PRICE_INDIVIDUAL` / `STRIPE_PRICE_FAMILY` / `STRIPE_PRICE_EXTRA_VEHICLE` = the price IDs
   - `STRIPE_WEBHOOK_SECRET` = whsec_… (from step 5)
   - optional `STRIPE_TAX` = `on` only after enabling Stripe Tax (TX SaaS is taxable)
4. **Deploy the two functions** (dashboard → Edge Functions → Deploy):
   - `stripe-checkout` — Verify JWT **ON**
   - `stripe-webhook` — Verify JWT **OFF** (Stripe signs requests; we verify the HMAC)
5. **Add the webhook endpoint** (Developers → Webhooks → Add endpoint):
   - URL: `https://fxycfrtycqxdlhrpfeiv.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (step 3).
6. **Test in Test mode**: throwaway account → Settings → Plan → INDIVIDUAL →
   card `4242 4242 4242 4242`, any future date/CVC → back in the app the tier
   should read *individual* within a minute. Then flip the dashboard to Live
   mode and repeat steps 2–5 with live keys (test and live have separate keys,
   prices, and webhooks).

## Notes

- Upgrade buttons render only on the **web** app for fleet owners on the
  free/expired tier. Native apps show "manage at motorlog.co" — selling
  outside IAP inside the iOS app violates App Review rule 3.1.1.
- Beta comps (migration 0013) outrank Stripe in `effective_tier()` until 2027;
  beta users see no buttons because their tier is already `family`.
- MANAGE BILLING opens the Stripe customer portal — enable it once at
  Settings → Billing → Customer portal in the Stripe dashboard.
