import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataDir } from "./helpers";
import { AUTO_RECHARGE_PLANS_ERROR, PLANS, isAutoRechargeAllowed } from "@/lib/catalog";
import { mockBilling } from "@/lib/billing/mock";
import * as H from "@/lib/billing/metronome-helpers";
import type Metronome from "@metronome/sdk";

const state = vi.hoisted(() => ({ cid: "" as string, plan: "free" as string, calls: [] as boolean[] }));
vi.mock("@/lib/session", () => ({ currentCustomerId: () => state.cid }));
vi.mock("@/lib/billing", () => ({
  billing: {
    get: async () => ({ customerId: state.cid, plan: state.plan }),
    setAutoRecharge: async (_: string, enabled: boolean) => { state.calls.push(enabled); return { customerId: state.cid, plan: state.plan, autoRecharge: enabled }; },
  },
}));
vi.mock("@/lib/serialize", () => ({ view: (a: unknown) => a }));

describe("auto-recharge only on Pro and Scale, never Free", () => {
  beforeEach(() => { freshDataDir(); state.calls = []; });
  it("catalog", () => {
    expect(isAutoRechargeAllowed("free")).toBe(false);
    expect(isAutoRechargeAllowed("pro")).toBe(true);
    expect(isAutoRechargeAllowed("scale")).toBe(true);
    expect(PLANS.free.autoRechargeAllowed).toBe(false);
  });
  it("mock provider rejects Free, allows Pro; turning off is always allowed", async () => {
    const f = await mockBilling.signup({ name: "Nebula demo Free", email: "f@example.com", plan: "free" });
    await expect(mockBilling.setAutoRecharge(f.customerId, true)).rejects.toThrow(AUTO_RECHARGE_PLANS_ERROR);
    await expect(mockBilling.setAutoRecharge(f.customerId, false)).resolves.toMatchObject({ autoRecharge: false });
    const p = await mockBilling.signup({ name: "Nebula demo Pro", email: "p@example.com", plan: "pro" });
    await expect(mockBilling.setAutoRecharge(p.customerId, true)).resolves.toMatchObject({ autoRecharge: true });
  });
  it("live helper rejects a Free contract before any edit", async () => {
    const edits: unknown[] = [];
    const client = { v2: { contracts: {
      retrieve: async () => ({ data: { id: "k", customer_id: "c", starting_at: "2026-09-01T00:00:00Z", custom_fields: { nebula_plan: "free" } } }),
      edit: async (b: unknown) => { edits.push(b); return { data: {} }; },
    } } } as unknown as Metronome;
    await expect(H.setAutoRecharge({ client, ids: {} as never }, "c", "k", true)).rejects.toThrow(AUTO_RECHARGE_PLANS_ERROR);
    expect(edits).toEqual([]);
  });
  it("API route: 403 plan_not_allowed on Free; Pro and turning off pass through", async () => {
    const { POST } = await import("@/app/api/autorecharge/route");
    const req = (enabled: boolean) => new Request("http://x/api/autorecharge", { method: "POST", body: JSON.stringify({ enabled }) });
    state.cid = "u1"; state.plan = "free";
    const r = await POST(req(true));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: AUTO_RECHARGE_PLANS_ERROR, code: "plan_not_allowed" });
    expect(state.calls).toEqual([]);
    expect((await POST(req(false))).status).toBe(200);
    state.plan = "pro";
    expect((await POST(req(true))).status).toBe(200);
    expect(state.calls).toEqual([false, true]);
  });
});
