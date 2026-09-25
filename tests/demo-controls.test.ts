import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { balance, mockBilling as b, withInsights } from "@/lib/billing/mock";
import { fastForward, personaAccount, resetDemo, trafficSpike } from "@/lib/demo";
import { nowIso } from "@/lib/clock";
import { getAccount, getDemoState } from "@/lib/store";
import { freshDataDir } from "./helpers";

const acc = (id: string) => getAccount(id)!;

beforeEach(() => {
  freshDataDir();
  process.env.MOCK_AUTO_PAYMENT_WEBHOOK = "1";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 8, 25, 12))); // Sep 25
});
afterEach(() => vi.useRealTimers());

describe("demo personas", () => {
  it("seeds the four personas with the state each one is meant to show", async () => {
    const s = await resetDemo();
    expect(Object.keys(s.personas).sort()).toEqual(["enterprise", "free", "pro", "scale"]);
    const free = acc(s.personas.free!), pro = acc(s.personas.pro!), scale = acc(s.personas.scale!), ent = acc(s.personas.enterprise!);
    // Free hobbyist: below the 20% threshold (€1) but not blocked
    expect(balance(free)).toBeGreaterThan(0); expect(balance(free)).toBeLessThan(1); expect(free.blocked).toBe(false);
    // Pro startup: auto-recharge on and already fired once (charges only the difference up to €50)
    expect(pro.autoRecharge).toBe(true);
    expect(pro.invoices.filter(i => i.description.startsWith("Auto-recharge"))).toHaveLength(1);
    expect(balance(pro)).toBeGreaterThan(10);
    // Scale: credits used up, overage below the €300 early-charge step
    expect(balance(scale)).toBe(0);
    expect(scale.overageAccrued).toBeGreaterThan(150); expect(scale.overageAccrued).toBeLessThan(300);
    // Enterprise prospect: recommender hints Enterprise
    expect(withInsights(ent).recommendation).toMatchObject({ enterpriseHint: true });
  });
  it("switching to a deleted persona seeds it again; reset clears the demo clock", async () => {
    const s = await resetDemo();
    const id = await personaAccount("scale");
    expect(id).toBe(s.personas.scale);
    fastForward(id);
    expect(getDemoState().clockOffsetMs).toBeGreaterThan(0);
    await resetDemo();
    expect(getDemoState().clockOffsetMs).toBe(0);
    expect(getAccount(id)).toBeNull();
  });
});

describe("traffic spike", () => {
  it("on Scale pushes overage past the next €300 step ⇒ one early charge", async () => {
    const id = await personaAccount("scale");
    const r = await trafficSpike(id);
    expect(r.earlyCharges).toBe(1);
    expect(r.summary).toMatch(/early charge of €300\.00/);
    expect(acc(id).spendPrepaid).toBe(300);
    expect(acc(id).alerts[0].message).toMatch(/Usage spike/);
  });
  it("on Pro triggers auto-recharge; on Free uses up the balance (402)", async () => {
    const pro = await personaAccount("pro");
    expect((await trafficSpike(pro)).summary).toMatch(/auto-recharge charged/);
    const free = await personaAccount("free");
    const r = await trafficSpike(free);
    expect(r.summary).toMatch(/API access paused/);
    expect(acc(free).blocked).toBe(true);
  });
});

describe("fast-forward to month end", () => {
  it("runs the month close: overage invoice, plan credits expire, new fee and credits; clock moves to Oct 1", async () => {
    const id = await personaAccount("scale");
    const overage = acc(id).overageAccrued;
    const r = fastForward(id);
    expect(nowIso() >= "2026-10-01T00:00:00.000Z").toBe(true);
    expect(r.periodStart).toBe("2026-10-01T00:00:00.000Z");
    expect(r.invoices.map(i => i.description)).toEqual(expect.arrayContaining([expect.stringMatching(/^Overage for/), "Scale monthly fee"]));
    expect(r.invoices.find(i => i.description.startsWith("Overage"))!.amount).toBeCloseTo(overage, 2);
    expect(r.summary).toMatch(/overage invoice/);
    const a = acc(id);
    expect(a.overageAccrued).toBe(0);
    expect(balance(a)).toBe(250);
    // New usage lands in the new period (demo clock)
    await b.ingest(id, [{ requestId: "after-ff", images: 10 }]);
    expect(acc(id).usage[0].ts >= "2026-10-01").toBe(true);
  });
  it("Free: unused plan credits expire and the new €5 arrive; other personas close lazily on the same clock", async () => {
    const free = await personaAccount("free");
    const pro = await personaAccount("pro");
    const left = balance(acc(free));
    const r = fastForward(free);
    expect(r.summary).toContain(`of unused plan credits expired`);
    expect(left).toBeGreaterThan(0);
    expect(balance(acc(free))).toBe(5);
    const p = (await b.get(pro))!;
    expect(p.periodStart).toBe("2026-10-01T00:00:00.000Z");
  });
});
