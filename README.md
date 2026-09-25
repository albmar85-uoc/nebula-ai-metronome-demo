# nebula.ai · Usage-based billing demo with Metronome + Stripe

Demo of a fictional SaaS, **nebula.ai**, that sells a generative-AI API (text and images) on usage-based plans. Billing is modeled in **Metronome** and payments go through **Stripe**. The UI is in English; amounts are in **EUR** with `en-US` formatting (e.g. `€1,234.50`). **All figures are sample data.**

- **Mock mode** (default): no external calls. It reproduces the agreed Metronome + Stripe behavior locally and stores data in `./data/db.json`, so it survives restarts.
- **Live mode** (Metronome live): calls the real Metronome API with the official SDK [`@metronome/sdk`](https://www.npmjs.com/package/@metronome/sdk) and uses Stripe Checkout in *setup* mode to save the card.

Every screen shows a **"Simulated mode"** (amber) or **"Live Metronome"** (green) badge; "simulated" and "mock" mean the same thing here.

## Catalog (sample data)

| | Free | Pro | Scale | Enterprise |
|---|---|---|---|---|
| Monthly fee | €0 | €29 | €199 | annual commitment (from €12,000) |
| Included credits/month | €5 | €30 | €250 | – (usage draws down the commitment) |
| Usage discount | – | 10% | 20% | negotiated per-metric rates |
| At €0 | access is cut off | access is cut off (or auto-recharge) | overage billed at month end; early charge every €300 of overage | true-up at year end |

Usage: input tokens €2/M, output tokens €8/M, images €0.04. Bundles (12 months, manual purchase only): pay €50 → get €55; €200 → €230; €1,000 → €1,200. Promo codes: `WELCOME10` (€10, 30 days) and `LAUNCH25` (€25, 60 days). Low-balance notice at 20% of plan credits and at €0.

Plan credits are prorated in the first month and expire monthly. Bundles, gifts and promos carry over on plan changes.

### Metronome expert decisions (mock mode matches them)

1. **Upgrade** (immediate RENEWAL transition): the **full remaining balance carries over** (`rollover_fraction: 1`) and the new plan's monthly credits are **granted prorated** by the days left in the cycle; the fee difference is prorated too. Downgrades are scheduled for the next period and keep bundles, gifts and promos.
2. **Auto-recharge** (Pro/Scale): when the balance drops **below €10**, it is **topped up to €50**, charging only the difference (e.g. balance €7.40 → charge €42.60). No gift. Gift credit only comes with **manually purchased** bundles.

Catalog names, promo codes and amounts are identical to the expert's (English) setup package. In live mode the app reads `catalog.plans[].display_name`, `catalog.bundles[].display_name` and `catalog.promotions` from `metronome-ids.json`; a test checks that `lib/catalog.ts` matches the setup's `metronome-ids.dry-run.json`.

## Presenting the demo

See **[DEMO_SCRIPT.md](DEMO_SCRIPT.md)** for a 10-minute presenter script (click path, the Metronome feature behind each step, likely audience questions).

- **Demo controls** (mock mode only): floating button at the bottom left, or **Shift+D**.
  - **Personas**: Free hobbyist near the limit · Pro startup with auto-recharge · Scale company with overage · Enterprise prospect. Each one is seeded through the normal billing engine (history, usage, alerts, invoices) and switching signs you in as that customer.
  - **Fast-forward to month end**: moves the demo clock to the end of the billing period and runs the month close: overage invoice (net of early charges), unused plan credits expire, next fee and recurring credits. It can be repeated (one month each time).
  - **Traffic spike**: a burst of large requests. On Scale it's sized to push overage past the next €300 step, so the early usage charge (spend threshold) fires. On Pro it triggers auto-recharge; on Free the balance runs out (402).
  - **Reset demo data**: wipes everything, resets the demo clock and seeds the personas again.
  - **Start guided tour**.
- **Guided tour** (no dependencies): 10 steps across pages (pricing, sign-up, usage, alerts, upgrade, bundle, promo, invoice preview, API keys, admin). It highlights each part of the screen and names the Metronome feature behind it. Start it from Demo controls or with `?tour=1`; arrow keys move, Esc ends.
- **Notifications**: every new alert (local or webhook) and every demo action shows as a toast at the bottom right. Toasts are large, color-coded by severity and announced by screen readers; clicks pass through them. The app polls the account every 5 s in mock mode (20 s live), so alerts caused elsewhere (curl, admin, webhooks) show up without a refresh.

The API behind the controls is `GET/POST /api/demo/controls` (`reset`, `persona`, `fast-forward`, `spike`). It returns 404 in live mode.

## What's in the app

| Page | What it does |
|---|---|
| `/` | Landing + pricing + Enterprise card. |
| `/signup` | Sign-up (Free/Pro/Scale). Live: Stripe Checkout in setup mode. |
| `/dashboard` | Balance, spend vs. monthly limit, 30-day usage chart, next invoice, **plan comparison**, usage simulator, alerts (`aria-live`), latest requests (simulator vs. API). |
| `/billing` | Plans (upgrade/downgrade), bundles, auto-recharge, Scale early threshold charge, **monthly spend limit**, promo codes, invoices. |
| `/keys` | **Per-user API keys**: create with a name, shown **once**, stored hashed, revoke. |
| `/docs` | Docs for the fictional nebula.ai API: auth, `POST /api/v1/completions`, `POST /api/v1/images`, examples, errors, billable-metric mapping. |
| `/admin` | **Support panel** (password `ADMIN_PASSWORD`, default `nebula-admin`): customer list/search, customer detail (plan, balance, spend, blocked status, credits/commits, plan history, invoices, alerts, recent usage, keys, support log) and actions: **goodwill credit**, **unblock**, **change plan**. |
| `/enterprise` | Proposal request (sample `EnterpriseContractSummary`). |

### Public API (fictional)

```bash
curl -X POST http://localhost:3000/api/v1/completions \
  -H "Authorization: Bearer nbl_test_…" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123" \
  -d '{"model":"nebula-text-1","prompt":"Hello, nebula","max_tokens":200}'
```

- Auth by API key (`Authorization: Bearer` or `X-API-Key`); 401 if missing, unknown or revoked.
- Returns canned responses and a `billing` block (`cost_eur`, metrics). Usage goes through **the same billing path** as the simulator (`billing.ingest`), with `transaction_id` = request id (or `idem_<Idempotency-Key>`); a replay returns `Idempotent-Replayed: true` and is not charged twice.
- `402 insufficient_balance` when Free/Pro has no balance; `402 spend_limit_reached` when the customer's monthly limit would be exceeded.
- Metric mapping: prompt → `input_tokens` (≈ chars/4), `max_tokens` (capped at the canned output) → `output_tokens`, `n` → `images`.

### Spend limit

The customer sets a monthly cap (€, discounted usage for the current period) in Billing. A notice fires once at **80%** and once at **100%** per period; the request that would exceed the cap is rejected with 402. Enforced by the app in both modes (see TODOs for the Metronome-native alternative).

### Plan recommender

Compares the last 30 days (projected to 30 when there are 7–29 days of data) under each plan: fee + usage after discount − included credits; on Free/Pro the extra is paid with the cheapest bundle that gets used within its 12 months, on Scale as overage. It shows savings vs. the current plan, coverage and notes, and suggests **Enterprise** when projected spend exceeds €1,500/month.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    L[Landing / pricing] --> S[/signup]
    D[/dashboard] & B[/billing] & K[/keys] & A[/admin] & DOC[/docs]
  end
  CURL[API clients<br/>curl / SDK] --> V1[/api/v1/completions<br/>/api/v1/images/]
  subgraph "Next.js 14 (App Router)"
    API[/app/api/*/]
    P{{"lib/billing/index.ts<br/>METRONOME_LIVE=1?"}}
    M[mock.ts<br/>simulation + period close]
    R[metronome.ts<br/>orchestration]
    HL[metronome-helpers.ts<br/>port of the setup helpers]
    ST[(data/db.json<br/>mock accounts, links, purchases,<br/>webhooks seen, request ids,<br/>API keys, plan history, admin log)]
    WH[/api/webhooks/metronome/]
  end
  IDS[(../metronome-setup/<br/>metronome-ids.json)]
  S & D & B & K & A --> API --> P
  V1 --> P
  P -- no --> M --> ST
  P -- yes --> R --> HL -- "@metronome/sdk 3.10.0" --> MET[(Metronome API)]
  R --> ST
  IDS --> HL
  S -. live .-> SC[Stripe Checkout<br/>setup mode] --> RET[/api/stripe/return/] --> R
  MET -- "charges invoices and commits" --> STR[(Stripe)]
  MET -- webhooks --> WH --> ST
```

| File | What it does |
|---|---|
| `lib/catalog.ts` | Metrics, plans, bundles, auto-recharge (below €10 → up to €50), Scale threshold (€300), priorities, promotions, Enterprise example. |
| `lib/billing/metronome-types.ts` | **Verbatim copy** of `metronome-setup/types.ts` (UI data contract). |
| `lib/billing/metronome-helpers.ts` | **`@metronome/sdk` port of `metronome-setup/src/helpers/*`**, same names and request bodies. A test checks they are **identical** to `dry-run-helpers.txt`. |
| `lib/billing/metronome-config.ts` | Loads `metronome-ids.json` (setup format incl. `catalog.*.display_name` and `catalog.promotions`); without a file builds the same object from env vars. Rejects dry-run files. |
| `lib/billing/metronome.ts` | Live mode: user ↔ Metronome link, idempotency with app ids, Free/Pro cut-off, bundle gift after payment, spend limit, support actions. |
| `lib/billing/mock.ts` | Same semantics simulated locally. |
| `lib/billing/insights.ts` | Pure calculations: 30-day usage, plan comparison/recommender, Enterprise proposal. |
| `lib/billing/limits.ts` | Spend limit: request cost, fit check, 80%/100% notices. |
| `lib/apikeys.ts`, `lib/publicApi.ts` | API keys (hash + timing-safe compare) and the fictional `/api/v1` endpoints. |
| `lib/admin.ts` | Support panel auth (HMAC-signed cookie, rate-limited login) and audit log. |
| `lib/webhooks.ts` | Signature + `interpretWebhook` → actions. |
| `lib/demo.ts`, `lib/personas.ts`, `lib/clock.ts` | Demo controls: persona seeding, month close, traffic spike, reset; the demo clock (offset stored in `db.json`, used by every mock timestamp). |
| `components/DemoControls.tsx`, `Tour.tsx`, `Toaster.tsx`, `toast.ts` | Presenter drawer, guided tour, notifications. |
| `lib/store.ts` | JSON store with atomic writes. |

## Run in mock mode

```bash
npm install
npm run build && npm start      # http://localhost:3000  (or npm run dev)
npm test                        # unit tests (vitest)
npm run test:e2e                # end-to-end tests (Playwright, own build on port 3100 and data in /tmp)
node scripts/screens.mjs        # refresh /workspace/screens (server running; resets demo data)
```

- `http://localhost:3000/api/demo` creates a sample Pro account (€50 bundle bought, 30 days of history) and opens the dashboard.
- Data lives in `./data/db.json`. Delete it to start fresh.
- Support panel: `http://localhost:3000/admin`, password `nebula-admin` (or `ADMIN_PASSWORD`).
- Mock webhook test (without a secret it's accepted and flagged "unsigned"). `threshold: 0` is the global €0 alert and cuts off Free/Pro:

```bash
curl -X POST localhost:3000/api/webhooks/metronome -H 'content-type: application/json' \
  -d '{"id":"test-1","type":"alerts.low_remaining_contract_credit_and_commit_balance_reached","properties":{"customer_id":"<customerId from /api/me>","threshold":0,"remaining_balance":0}}'
```

- Idempotent ingest: `POST /api/usage` with `{"requests":[{"requestId":"req-1","inputTokens":1000,"outputTokens":500}]}`. Repeating the same `requestId` returns `duplicates: 1` and doesn't charge.

## Switch to live mode

1. Run the expert's setup (`cd ../metronome-setup && npm run setup`, **without** `--dry-run`). It generates `metronome-ids.json`, which the app reads from `../metronome-setup/metronome-ids.json` (or `METRONOME_IDS_FILE`).
2. Copy `.env.example` to `.env` and fill in:

| Variable | Required | What it is / who provides it |
|---|---|---|
| `METRONOME_LIVE=1` | yes | Enables live mode (without it the demo stays mocked even with a token). |
| `METRONOME_API_KEY` (or `METRONOME_API_TOKEN` / `METRONOME_BEARER_TOKEN`) | yes | Metronome **Sandbox** token connected to Stripe test mode (**Metronome expert**). |
| `METRONOME_IDS_FILE` | no | Path to the IDs file. |
| `METRONOME_WEBHOOK_SECRET` | once public | Secret of the webhook pointing to `https://<app>/api/webhooks/metronome` (needs a public URL: tunnel or deployment). Until then live mode polls balances; `scripts/live-server.sh` generates a local secret for replaying signed payloads. |
| `STRIPE_SECRET_KEY` | yes | Secret key of the **same Stripe account** connected to Metronome (**Stripe expert**). |
| `APP_URL` | recommended | Public URL for Stripe return URLs. |
| `ADMIN_PASSWORD` | recommended | Support panel password (default `nebula-admin`). |
| `API_KEY_PEPPER` | no | Pepper for API key hashes. |
| `METRONOME_*` (individual IDs) | no | Alternative to `metronome-ids.json` (see `.env.example`). |

Dashboard-only prerequisites: see section 3 of the `metronome-setup` README (Sandbox, Stripe connection, `prod_…` products in Stripe and the `stripe_product_id` mapping rule, webhook, default payment method, EUR enabled).

### `metronome-ids.json` format

Exactly `metronome-setup/src/ids.ts` (example: `metronome-setup/metronome-ids.dry-run.json`):

```jsonc
{
  "generated_at": "…", "base_url": "https://api.metronome.com", "dry_run": false,
  "credit_types": { "EUR": "<uuid>" },
  "billable_metrics": { "input_tokens": "…", "output_tokens": "…", "images": "…" },
  "products": {
    "usage":        { "input_tokens": "…", "output_tokens": "…", "images": "…" },
    "subscription": { "pro": "…", "scale": "…" },
    "fixed": { "plan_credits": "…", "bundle_commit": "…", "bundle_bonus": "…", "auto_recharge": "…",
               "spend_threshold": "…", "promo_credit": "…", "enterprise_commit": "…" }
  },
  "rate_card": { "id": "…", "alias": "nebula_eur" },
  "alerts": { "zero_balance": "…", "zero_balance_uniqueness_key": "nebula-zero-balance-eur-v1" },
  "event_types": { "input_tokens": "nebula_llm_request", "output_tokens": "nebula_llm_request", "images": "nebula_image_generation" },
  "event_properties": { "input_tokens": "input_tokens", "output_tokens": "output_tokens", "images": "images" },
  "auto_recharge": { "threshold_eur": 10, "recharge_to_eur": 50 },
  "spend_threshold": { "scale_threshold_eur": 300 },
  "amount_scale": 1,
  "catalog": {
    "plans":   { "pro": { "display_name": "Pro", "monthly_fee_eur": 29, "monthly_credits_eur": 30, "usage_multiplier": 0.9, "subscription_product_id": "…" }, … },
    "bundles": { "b50": { "display_name": "€50 bundle (+€5 bonus)", "paid_eur": 50, "bonus_eur": 5 }, … },
    "promotions": { "WELCOME10": { "display_name": "Welcome bonus", "amount_eur": 10, "valid_days": 30 },
                    "LAUNCH25":  { "display_name": "Launch campaign", "amount_eur": 25, "valid_days": 60 } }
  }
}
```

Older files without `display_name`/`promotions` are completed from `lib/catalog.ts`.

## Which Metronome call backs each screen

Bodies are the setup helpers' (checked by the expert against `spec/openapi.json`) and are also type-checked against `@metronome/sdk` 3.10.0. **EUR amounts = whole units.**

| Screen / endpoint | Live mode (helper → endpoint) |
|---|---|
| `/signup` → `POST /api/stripe/setup-session` | Stripe `customers.create` + `checkout.sessions.create({ mode: "setup" })`. |
| `GET /api/stripe/return` | Stripe `checkout.sessions.retrieve` + `customers.update(default_payment_method)`; `createCustomerWithStripe` (idempotent by ingest alias), `createPlanContract` (`uniqueness_key` `nebula-signup-<customer>`; Scale with `spend_threshold_configuration`), `syncPlanLowBalanceAlert`. |
| `GET /api/me`, `/dashboard`, `/billing` | `getBalanceSummary`, `listInvoices`, `getContract` (auto-recharge and threshold), `getUpcomingInvoicePreview` (DRAFT USAGE for the period), `getUsageLast30Days` (`POST /v1/usage`, DAY) → chart + plan comparison. |
| `POST /api/usage`, `POST /api/v1/*` | Free/Pro: rejected (402) if a €0 webhook cut access or `getNetBalanceEur` ≤ 0; rejected if the spend limit would be exceeded. Then `ingest` (`POST /v1/ingest`): **one event per request** with `transaction_id` = **app request id** (`:images` suffix for the image part). |
| `POST /api/plan/change`, admin "Change plan" | `changePlan`: `POST /v1/contracts/create` with `transition: { type: "RENEWAL", from_contract_id }`, same billing anchor. Upgrade: now, prorated fee + prorated new credits, full balance rolls over (`rollover_fraction: 1`). Downgrade: next period. Then `syncPlanLowBalanceAlert`. |
| `POST /api/bundles/buy` | `buyBundle` → `/v2/contracts/edit` `add_commits` PREPAID with payment gate, `uniqueness_key nebula-bundle-<id>`; on `payment_gate.payment_status = paid`, `findBundleCommit` + `grantBundleBonus` (`nebula-bonus-<id>`). |
| `POST /api/autorecharge` | `setAutoRecharge` → `add_/update_prepaid_balance_threshold_configuration` (below €10 → top up to €50, commit with payment gate). |
| `POST /api/spend-threshold` (Scale) | `setSpendThreshold` → `add_/update_spend_threshold_configuration` (€300, Stripe payment gate). Mutually exclusive with auto-recharge. |
| `POST /api/promo` | Code looked up in `catalog.promotions`; `grantPromoCredit` → `add_credits` with expiry, priority 3, `uniqueness_key nebula-promo-<customer>-<code>` (409 ⇒ "already redeemed"). |
| `POST /api/spend-cap` | App-side limit stored on the customer link (no Metronome call). |
| Admin "Grant goodwill credit" | `grantPromoCredit` with code `GOODWILL-<grantId>` (idempotent by grant id), priority 3, expiry. |
| Admin "Unblock access" | Clears the local cut-off flag (balance is unchanged; the next ingest re-checks `getNetBalanceEur`). |
| `/billing/invoices/:id` | `getInvoice`. |
| `POST /api/webhooks/metronome` | HMAC signature → `interpretWebhook`: `offer_top_up`, `cut_access`, `payment_succeeded`, `payment_failed`, `payment_requires_action`, `threshold_charge_started`. Deduped by `id` in `db.json` **after** processing. |

Burn-down priorities (same as the setup): plan 1 → promo/goodwill 3 → bundle gift 5 → paid commits 10 → Enterprise 20.

## Tests

- `npm test` (vitest): `mock-billing` (billing semantics incl. the expert decisions), `webhooks`, `metronome-helpers` (**parity with `metronome-setup/dry-run-helpers.txt`**, ID loading incl. `display_name`/`promotions`, catalog parity with the setup), `support-api-limits` (recommender, spend limit, support actions, API keys, public API), `demo-controls` (personas, spike → early charge / auto-recharge / cut-off, fast-forward month close, reset).
- `npm run test:e2e` (Playwright, system Chrome): full journey — Free sign-up → usage until blocked (402) → upgrade to Pro → bundle purchase → `WELCOME10` → API key + cookie-less `fetch` like curl (401/200/idempotent replay) → spend limit 402 → key revocation → admin goodwill credit; plus accessibility (axe WCAG 2.1 A/AA, no serious/critical issues) and 390 px mobile checks on every page (including the drawer and the tour), keyboard skip link and focus, low-balance modal focus/Escape; and the presenter tooling: Shift+D, reset, personas, spike on Scale/Pro, fast-forward, toasts, and the 10-step tour across pages.

## Live mode verified (Metronome Sandbox + Stripe test, 2026-09-25)

Run it with `scripts/live-server.sh` (port 3001, own build `.next-live` and data `data-live/`, credentials from `.env.local`,
which always wins over variables exported in your shell). With a Stripe **test** key it also enables
`POST /api/stripe/test-signup` (`{ plan, testCard: "pm_card_visa" | "pm_card_authenticationRequired" | … }`): sign-up
without the hosted Checkout page, names forced to "Nebula demo …". The mock demo on :3000 is unaffected.

**Verified live**
- Environment is `SANDBOX`. `metronome-ids.json` (final) loads, and the catalog and promotions come from it.
- Sign-up (Free, Pro): Stripe customer + default PM → Metronome customer (ingest alias = app user id, Stripe billing config) → plan contract (`uniqueness_key` per customer) → 20 % alert per plan.
- Ingest: one event per request, `transaction_id` = request id; re-sends are deduplicated (locally and by Metronome). Balance drops within ~15 s (Free €5 → €0.90 → €0).
- Balances: `customerBalances/list` **rejects `limit` > 25** (undocumented) → the adapter uses pages of 25 (`BALANCES_PAGE_LIMIT`).
- Alerts: without webhooks, balances are **polled** on each `/api/me` (10 s cache per customer, refreshed by every write). Crossing 20 % → `low_balance`, reaching €0 → `zero_balance`, both once per contract period. Metronome's own alert status agrees (`/v1/customer-alerts/list`: 20 % and €0 `in_alarm` at exactly €0). On upgrade, the Free 20 % alert is replaced by the Pro one.
- Free cut-off: at €0 the next request is rejected (`blocked`, 402 on the public API).
- Upgrade Free→Pro and Pro→Scale (`RENEWAL` transition): the whole balance carries over (€5 + €30; €30 + €250), the new plan credits are added, and the Scale contract has the €300 spend threshold with the Stripe payment gate.
- Plan fee: subscription `ADVANCE`, `is_prorated: true`, `BILL_IMMEDIATELY` → a `SCHEDULED` invoice ("nebula Pro plan", €29) finalized at contract start. The next period's fee shows on the current draft (billed in advance, **not** a double charge).
- WELCOME10: €10 until +30 days; a second redeem gives "You have already redeemed the code WELCOME10".
- Auto-recharge config: accepted, including `duration` 12 months and `rollover_fraction` 1 (not in SDK 3.10.0 typings). Can be turned off.
- Invoices: listing, draft preview (English line names, "Free credits applied" lines), 30-day usage from `/v1/usage`.
- Webhook handler: signed replays (local secret) → processed, duplicate detected, bad signature rejected with 401.

**Differs from mock**
- Billing periods are **anniversary-based** (contract start = sign-up hour, floored), not calendar months, and the first period isn't prorated (full plan credits). The spend limit now uses the contract period from the draft invoice.
- The last request before €0 can overshoot. Metronome bills the excess on the Free contract (e.g. €2.50 overage on the draft). The mock never charges Free. A decision is needed (see below).
- A finalized invoice that Stripe rejects shows as **"payment failed"** (from `external_invoice.external_status` / `billing_provider_error`), with an English customer alert. The raw provider error is only shown in the admin panel.
- A failed bundle payment gate is **synchronous**: `/v2/contracts/edit` returns 400 and no commit is created. The API answers **402** `{ code: "payment_failed", error: "Payment failed: we couldn't charge your card for the €50.00 bundle, so nothing was added…" }`. The purchase is marked failed and the UI shows the message.
- A successful bundle is confirmed by polling `findBundleCommit`, both right after the purchase and on reads, because payment webhooks can't arrive yet.

**Not verified: blocked or needs setup**
- **Any successful charge** (plan fee, bundle, auto-recharge top-up, Scale threshold charge, 3DS). Metronome and the Stripe keys were first on different accounts (Metronome `acct_1T56leGe…`, keys `acct_1T56lXGb…`): fee invoices ended `INVALID_REQUEST_ERROR "No such customer"` and the bundle gate failed with "could not read the default payment method… No such customer". After the keys were switched to `acct_1T56leGe…`, Metronome **started rejecting customer creation** with `404 The specified customer was not found`, for every Stripe customer, including the Metronome expert's own previously accepted `Test Customer` (`/v1/customers` with `customer_billing_provider_configurations`, `direct_to_billing_provider` or explicit `delivery_method_id`). So no matched customer could be created. The Metronome ↔ Stripe connection needs checking (test mode vs live mode?).
- **Webhooks from Metronome**: they need a public URL (a tunnel such as cloudflared or ngrok, or a deployment) and the secret from the dashboard (`METRONOME_WEBHOOK_SECRET`). Until then the app polls.
- **Integration rule** `stripe_product_id → invoiceitem.price` (Metronome dashboard, pending): Stripe invoice items won't be tied to Stripe products/prices until it's set.
- Fee proration on upgrade: the test customers were upgraded in the same hour as sign-up, so the prorated fee equals the full fee. Check with a customer that is at least a day into its period.

## Open TODOs

Described here (design points are marked in code as "Open design point"):

1. **Live mode** was verified in the Sandbox except for successful charges and webhook delivery (see "Live mode verified").
2. **Outdated SDK types**: `duration` and `rollover_fraction` on the auto-recharge commit are sent outside the SDK type (verified accepted live).
3. **Fee credit on upgrade** via transition: the mock credits the unused part of the previous fee; confirm what Metronome does with FIRST_AND_LAST proration.
4. **Cancelling a scheduled downgrade** in live mode needs archiving the future contract (`/v1/contracts/archive`), which isn't in the setup helpers; the app asks the user to contact support.
5. **Payment webhook matching**: `payment_gate.payment_status` has no purchase id; checked via `findBundleCommit` (also used by polling). Failed gates are synchronous (verified); successful ones are pending a working Stripe connection.
6. **Promo credits with rollover**: do they keep their expiry after a plan transition?
7. **Alerts**: the €0 alert is `in_alarm` at exactly €0 (verified). End-of-month sign-ups can start below the fixed 20% threshold and notify immediately.
8. **Auto-recharge and spend threshold** treated as mutually exclusive (like the setup); confirm. Auto-recharge minimums are documented in $; assumed the same in EUR.
9. **30-day usage in live mode**: `/v1/usage` gives quantities; the daily cost is estimated with the rate and plan discount.
10. **Spend limit** is enforced by the app with locally tracked usage; live mode uses the contract period (anniversary). A Metronome spend/usage alert could replace it.
11. **Goodwill credit** uses the `promo_credit` product; a dedicated `goodwill_credit` product in the setup would separate it in reports.
12. **Admin customer list** in live mode reads each customer's balance from Metronome; needs pagination/caching at scale. The admin password is a demo mechanism, not real auth.
13. **Stripe 3D Secure**: shown as a notice, no link to complete the payment yet.
14. **Enterprise**: the request is only stored locally; `createEnterpriseContract` is not called from the web app.
15. **Persistence**: `data/db.json` is single-process; multiple instances need a real database.
16. **Demo clock** is mock-only and global (all mock accounts move together). There's no live equivalent: in a Metronome Sandbox you'd wait for the period end or create contracts with past start dates.
17. **Free overshoot**: the request that crosses €0 is accepted and Metronome bills the excess on the Free contract (seen live: €2.50). Options: reserve an estimated cost before each request, or have the Free contract not bill usage beyond its credits (Metronome expert).
