import { describe, expect, it } from "vitest";
import Metronome from "@metronome/sdk";
import * as H from "@/lib/billing/metronome-helpers";

const input = { customerId: "cus-1", contractId: "con-1", balanceId: "bal-1", segmentId: "seg-1", amountEur: 5, reason: "Outage refund", operationId: "adj_42" };
const fakeCtx = (impl: (body: Record<string, unknown>) => Promise<void>) => {
  const calls: Record<string, unknown>[] = [];
  const ctx = { ids: { amount_scale: 1 }, client: { v1: { contracts: { addManualBalanceEntry: async (b: Record<string, unknown>) => { calls.push(b); return impl(b); } } } } };
  return { ctx: ctx as unknown as Parameters<typeof H.addManualBalanceEntry>[0], calls };
};

describe("manual balance entries carry a deterministic uniqueness_key", () => {
  it("same operation → same key; different operation or balance → different key; ≤128 chars", () => {
    const k = H.manualBalanceEntryKey(input);
    expect(k).toBe("nebula-manual-cus-1-bal-1-adj_42");
    expect(H.manualBalanceEntryKey(input)).toBe(k);
    expect(H.manualBalanceEntryKey({ ...input, operationId: "adj_43" })).not.toBe(k);
    expect(H.manualBalanceEntryKey({ ...input, balanceId: "bal-2" })).not.toBe(k);
    expect(H.manualBalanceEntryKey({ ...input, operationId: "x".repeat(300) }).length).toBe(128);
  });
  it("sends uniqueness_key in the body (not in the SDK 3.10.0 types) with the documented fields", async () => {
    const { ctx, calls } = fakeCtx(async () => undefined);
    expect(await H.addManualBalanceEntry(ctx, input)).toEqual({ applied: true, uniquenessKey: "nebula-manual-cus-1-bal-1-adj_42" });
    expect(calls[0]).toEqual({ customer_id: "cus-1", contract_id: "con-1", id: "bal-1", segment_id: "seg-1", amount: 5, reason: "Outage refund", uniqueness_key: "nebula-manual-cus-1-bal-1-adj_42" });
  });
  it("a retry of the same operation (409) is treated as already applied, not an error", async () => {
    const { ctx, calls } = fakeCtx(async () => { throw Metronome.APIError.generate(409, { message: "uniqueness key already used" }, "conflict", new Headers()); });
    expect(await H.addManualBalanceEntry(ctx, input)).toEqual({ applied: false, uniquenessKey: "nebula-manual-cus-1-bal-1-adj_42" });
    expect(calls).toHaveLength(1);
  });
  it("other errors propagate", async () => {
    const { ctx } = fakeCtx(async () => { throw Metronome.APIError.generate(400, { message: "bad segment" }, "bad", new Headers()); });
    await expect(H.addManualBalanceEntry(ctx, input)).rejects.toThrow(/bad segment/);
  });
});
