import { describe, expect, it } from "vitest";
import { polledAlertKinds } from "@/lib/billing/metronome";
import * as H from "@/lib/billing/metronome-helpers";

describe("live mode: alerts derived from polled balances", () => {
  const low = 1; // Free: 20% of €5
  it("no baseline or no change → no alert", () => {
    expect(polledAlertKinds(undefined, 0.5, low)).toEqual([]);
    expect(polledAlertKinds(0.9, 0.9, low)).toEqual([]);
  });
  it("crossing below 20% → low", () => expect(polledAlertKinds(5, 0.9, low)).toEqual(["low"]));
  it("already below → no repeated low", () => expect(polledAlertKinds(0.9, 0.4, low)).toEqual([]));
  it("reaching 0 → zero (and no low)", () => {
    expect(polledAlertKinds(0.9, 0, low)).toEqual(["zero"]);
    expect(polledAlertKinds(5, -0.2, low)).toEqual(["zero"]);
  });
  it("balance going up (top-up, upgrade) → no alert", () => expect(polledAlertKinds(0, 30, 6)).toEqual([]));
});

describe("balances list pagination", () => {
  it("page size never exceeds 25 (customerBalances/list rejects more)", async () => {
    expect(H.BALANCES_PAGE_LIMIT).toBeLessThanOrEqual(25);
    const seen: number[] = [];
    const client = { v1: { contracts: { listBalances: (p: { limit: number }) => { seen.push(p.limit); return (async function* () { /* empty */ })(); } } } };
    await H.findBundleCommit({ client } as unknown as Parameters<typeof H.findBundleCommit>[0], "c", "p");
    expect(seen).toEqual([25]);
  });
});

import { mapInvoice } from "@/lib/billing/metronome";
import { PaymentFailedError, paymentFailedMessage } from "@/lib/billing/types";
import { view } from "@/lib/serialize";

describe("failed charges (as seen live)", () => {
  // Real shape: plan fee invoice finalized by Metronome, rejected by Stripe.
  const raw = { id: "cc9c", status: "FINALIZED", type: "SCHEDULED", totalEur: 29, currency: "EUR", issuedAt: "2026-09-25T19:00:00Z",
    lines: [{ name: "nebula Pro plan", type: "subscription", totalEur: 29 }], stripeStatus: "INVALID_REQUEST_ERROR", stripeError: "No such customer: 'cus_x'" };
  it("maps a failed Stripe hand-off to status failed with the plan name", () => {
    const i = mapInvoice(raw);
    expect(i.status).toBe("failed");
    expect(i.description).toBe("nebula Pro plan");
    expect(i.paymentError).toContain("No such customer");
  });
  it("hides the raw provider error from the customer view, keeps it for admin", () => {
    const a = { mode: "metronome", invoices: [mapInvoice(raw)], usage: [], daily: [], credits: [], periodStart: "2026-09-25T19:00:00Z", grants: [] } as never;
    expect(view(a).invoices[0].paymentError).toBeUndefined();
    expect(view(a, true).invoices[0].paymentError).toContain("No such customer");
  });
  it("payment gate errors carry a clear English message", () => {
    const e = new PaymentFailedError(paymentFailedMessage("the €50.00 bundle"), "400 Cannot add a Stripe payment-gated commit");
    expect(e.code).toBe("payment_failed");
    expect(e.message).toMatch(/^Payment failed: we couldn't charge your card for the €50\.00 bundle/);
  });
});
