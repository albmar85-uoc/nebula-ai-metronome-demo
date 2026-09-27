import { beforeEach, describe, expect, it } from "vitest";
import { closePeriods, draftInvoice, mockBilling as b } from "@/lib/billing/mock";
import { mapInvoice } from "@/lib/billing/metronome";
import { parseBillableStatus, UNBILLABLE_LABEL } from "@/lib/billing/types";
import { customerInvoice, view } from "@/lib/serialize";
import { getAccount, saveAccount } from "@/lib/store";
import { freshDataDir } from "./helpers";

beforeEach(() => { freshDataDir(); process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "1"; });

const raw = (billableStatus?: string) => ({ id: "i1", status: "FINALIZED", type: "USAGE", totalEur: 0, currency: "EUR", lines: [], billableStatus });

describe("billable_status (live)", () => {
  it("narrows the SDK's unknown to the two documented values", () => {
    expect(parseBillableStatus("unbillable")).toBe("unbillable");
    expect(parseBillableStatus("billable")).toBe("billable");
    expect(parseBillableStatus("UNBILLABLE")).toBeUndefined();
    expect(parseBillableStatus(3)).toBeUndefined();
  });
  it("mapInvoice keeps the narrowed value for the UI and the raw value for admin", () => {
    expect(mapInvoice(raw("unbillable"))).toMatchObject({ billableStatus: "unbillable", billableStatusRaw: "unbillable" });
    expect(mapInvoice(raw("pending_review"))).toMatchObject({ billableStatus: undefined, billableStatusRaw: "pending_review" });
    expect(mapInvoice(raw())).not.toHaveProperty("billableStatus");
  });
  it("the raw value is admin-only", () => {
    const i = mapInvoice(raw("unbillable"));
    expect(customerInvoice(i)).toMatchObject({ billableStatus: "unbillable", billableStatusRaw: undefined });
    const a = { mode: "metronome", invoices: [i], usage: [], daily: [], credits: [], periodStart: "2026-09-01T00:00:00Z" } as never;
    expect(view(a).invoices[0].billableStatusRaw).toBeUndefined();
    expect(view(a, true).invoices[0].billableStatusRaw).toBe("unbillable");
  });
  it("label is English", () => expect(UNBILLABLE_LABEL).toBe("Not sent to Stripe"));
});

describe("billable_status (mock demo)", () => {
  it("Free: the month close records a €0 usage invoice marked unbillable (the draft is not marked, as live)", async () => {
    const s = await b.signup({ name: "F", email: "f@x", plan: "free" });
    await b.ingest(s.customerId, [{ requestId: "bs-1", images: 10 }]); // €0.40, covered by Free credits
    const a = getAccount(s.customerId)!;
    expect(draftInvoice(a).billableStatus).toBeUndefined();
    closePeriods(a, +new Date(a.periodEnd) + 1000); saveAccount(a);
    const inv = getAccount(s.customerId)!.invoices.find(i => i.type === "usage")!;
    expect(inv).toMatchObject({ amount: 0, billableStatus: "unbillable" });
    expect(inv.lines!.map(l => l.amount)).toEqual([0.4, -0.4]);
  });
  it("paid plans stay billable (no label)", async () => {
    const s = await b.signup({ name: "P", email: "p@x", plan: "pro" });
    const a = getAccount(s.customerId)!;
    expect(draftInvoice(a).billableStatus).toBeUndefined();
    expect(a.invoices.every(i => i.billableStatus === undefined)).toBe(true);
  });
});
