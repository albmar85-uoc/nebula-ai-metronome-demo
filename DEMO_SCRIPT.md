# nebula.ai demo: 10-minute presenter script

A live walkthrough of usage-based billing with **Metronome** (metering, pricing, credits, invoicing) and **Stripe** (payments), using the fictional AI API company **nebula.ai**. Everything runs in **mock mode** (the amber "Simulated mode" badge): no real customers or charges, same behavior as the live integration. All figures are sample data.

## Before you start (2 minutes, before the audience joins)

1. `npm run build && npm start`, then open `http://localhost:3000` in a clean browser window, full screen, zoom 110–125%.
2. Open **Demo controls** (button at the bottom left, or **Shift+D**) → **Reset demo data** → **Confirm**. This seeds four personas and sets the demo date back to today.
3. Keep a second tab open on `http://localhost:3000/admin` (password `nebula-admin` unless `ADMIN_PASSWORD` is set).
4. Optional: a terminal with an API key ready for the curl step (create one in step 7, or ahead of time).

Notifications pop up at the bottom right for every alert (low balance, auto-recharge, early charges, support credit). Mention them as they appear: in production they arrive as Metronome webhooks.

**Shortcuts:** Shift+D opens/closes Demo controls. `?tour=1` on any URL starts the guided tour (arrow keys move, Esc ends). The guided tour covers the same ground in 10 steps if you'd rather follow on-screen prompts.

## The script

| # | Time | Click path | What to say | Metronome feature |
|---|---|---|---|---|
| 1 | 0:00–1:00 | Landing `/` → scroll to **Pricing** | "Three self-serve plans plus Enterprise. Each plan is a monthly fee plus included credits and a usage discount. Usage is metered per token and per image." | **Rate card** with per-metric prices (input tokens, output tokens, images); **plans as contracts** with a subscription fee and **recurring credits**. |
| 2 | 1:00–1:45 | **Create a free account** → sign-up form (don't submit, or submit as yourself on Free) | "Sign-up creates the customer in Metronome and a contract for the plan. In live mode, Stripe Checkout saves the card; Metronome charges it later." | **Customer + contract creation** (idempotent `uniqueness_key`), Stripe as the **billing provider**, first month **prorated**. |
| 3 | 1:45–3:00 | Demo controls → **Free hobbyist near the limit** (Hana). Dashboard: balance, 30-day chart, **Traffic simulator** → set Intensity to x20 → **Continuous traffic** (or **Traffic spike** in Demo controls) | "Every API call is one usage event. Hana has €5 of monthly credits and is already under 20% (the low-balance banner). Keep sending: at €0 the notification fires and the API pauses with a 402." | **Ingest API** (one event per request, `transaction_id` = request id, so retries never double-charge); **balance alerts** (20% and €0) → webhook → access cut-off. |
| 4 | 3:00–4:00 | **Billing** → **Upgrade to Pro** | "Upgrades are immediate. She pays the prorated difference, keeps her whole remaining balance, and gets Pro's credits prorated for the rest of the month. Access is back instantly." | **Contract transition** (RENEWAL) with **rollover** of credits and commits; **proration**; the low-balance alert is re-synced to the new plan. |
| 5 | 4:00–5:00 | Billing → **Buy balance**: pay €50 → get €55 · then **Promo code** `WELCOME10` → **Redeem** | "Prepaid bundles give bonus credit. The bonus is only added after Stripe confirms the payment. Promo codes add expiring credit, once per customer." | **Prepaid commit** behind a **Stripe payment gate**; bonus **credit** granted on the `payment_gate.payment_status` webhook; **promotional credit** with expiry; **burn-down priorities** (plan → promo → gift → paid). |
| 6 | 5:00–5:45 | **Usage** tab → **Next invoice** card, then **Are you on the right plan?** | "The next invoice updates in real time as usage comes in: usage by metric, discounts, credits applied, next month's fee. The recommender compares the last 30 days under every plan." | **Draft invoice** for the current period (real-time invoice preview); usage summaries from `/v1/usage`. |
| 7 | 5:45–6:45 | **API keys** → name it "demo" → **Create key** → copy. In a terminal: `curl -X POST localhost:3000/api/v1/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"prompt":"Hello, nebula","max_tokens":200}'` → back to **Usage** → **Latest requests** | "Developers use named keys (shown once, stored hashed). The API call is billed through exactly the same path as the simulator: it appears in the dashboard within seconds." | Same **ingest** path; **idempotency** via `Idempotency-Key` → `transaction_id`. `402` when out of balance or over the customer's **spend limit**. |
| 8 | 6:45–7:45 | Demo controls → **Pro startup with auto-recharge** (Leo) → **Traffic spike** | "Leo's balance drops below €10, so auto-recharge tops it back up to €50, charging only the difference. No manual top-ups, no interrupted API." | **Prepaid balance threshold** (auto-recharge) with a payment-gated commit. |
| 9 | 7:45–9:00 | Demo controls → **Scale company with overage** (Priya) → **Traffic spike**, then **Fast-forward to month end** → **Billing** → invoices | "Scale never blocks: usage past the credits is overage. Every €300 of overage is charged early to limit credit risk: that's the spike notification. At month end Metronome issues the overage invoice (net of early charges), unused plan credits expire and next month's fee and credits arrive." | **Spend threshold** (early charge, `payment_gate.threshold_reached`); **end-of-period invoicing**; **credit expiry** and new **recurring credits**. |
| 10 | 9:00–10:00 | Admin tab → search "Priya" or "Hana" → customer detail → **Grant credit** €5 "outage on 9/24" · then Demo controls → **Enterprise prospect** | "Support sees the same data the customer sees (balance, credits, invoices, plan history) and can grant goodwill credit, unblock or change plan; the customer gets a notification. For heavy users like Vertex Health, the recommender suggests Enterprise: an annual commitment with negotiated rates." | **Credits via the contract API** (idempotent per grant); plan changes as transitions; **Enterprise contract** with a prepaid **commit**, true-up and custom rates. |

**If you're short on time**, skip steps 2 and 7. **If something goes wrong**, Demo controls → Reset demo data, pick the persona and continue from that step.

## Likely audience questions

**Is this real Metronome or a simulation?**
The demo runs in mock mode so it's safe to present. With `METRONOME_LIVE=1`, a Sandbox token and the IDs from the Metronome setup script, the same screens call the real Metronome API through the official `@metronome/sdk`. The request bodies are checked in tests against the setup package's dry run.

**How do you avoid double-charging on retries?**
Each API request has an id that becomes the Metronome `transaction_id`. Metronome deduplicates events with the same `transaction_id`, and the app also skips ids it has already sent. Public API clients can pass `Idempotency-Key`.

**What happens when a Free or Pro customer runs out of balance?**
Metronome's €0 balance alert fires a webhook and the app pauses API access (`402 insufficient_balance`). Buying a bundle, redeeming credit, upgrading or turning on auto-recharge restores access.

**Why doesn't Scale get blocked?**
Scale is post-paid for usage beyond its credits (overage, billed at month end). To limit risk, Metronome's spend threshold charges every €300 of overage early, and the month-end invoice subtracts what was already paid.

**What happens to my balance when I upgrade or downgrade?**
Upgrades apply immediately: the prorated fee difference is charged, the whole remaining balance carries over and the new plan's monthly credits are granted prorated. Downgrades take effect at the next period; bundles, gifts and promos are kept.

**How does auto-recharge work, and does it add bonus credit?**
When the balance drops below €10, it's topped up to €50, charging only the difference. There's no bonus; bonus credit only comes with manually purchased bundles.

**Which credit is used first?**
Plan credits, then promo and goodwill credit, then bundle bonuses, then paid balance (Metronome priorities 1 → 3 → 5 → 10). Within a type, whatever expires first.

**Can customers cap their spend?**
Yes: a monthly spend limit in Billing. They're notified at 80% and requests that would exceed it get `402 spend_limit_reached`. The app enforces it; a Metronome usage alert could drive it in production.

**How are invoices and payments handled?**
Metronome generates invoices (fees, usage, credits applied) and charges them through the connected Stripe account. The app never stores card data; Stripe Checkout saves the card in setup mode.

**Can pricing change without code changes?**
Prices, credits and plans live in Metronome (rate card, products, contracts). The app reads the catalog from the setup's `metronome-ids.json`, including display names and promo codes.

**How does Enterprise differ?**
An annual contract with a prepaid commitment, negotiated per-metric rates and a true-up at year end. In the demo, the proposal is a sample; sales would create it with the setup's Enterprise helper.

**What isn't covered yet?**
A Sandbox run against real Metronome, 3-D Secure completion links, multi-instance persistence (the demo uses a JSON file) and some confirmations listed as TODOs in the README.
