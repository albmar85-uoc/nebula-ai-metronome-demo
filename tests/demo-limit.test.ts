import { beforeEach, describe, expect, it } from "vitest";
import Metronome from "@metronome/sdk";
import { mockBilling as b } from "@/lib/billing/mock";
import * as H from "@/lib/billing/metronome-helpers";
import { DEMO_LIMIT_MESSAGE, DemoLimitError, isArchivableDemoCustomer } from "@/lib/billing/types";
import { getAccount } from "@/lib/store";
import { freshDataDir } from "./helpers";

beforeEach(() => { freshDataDir(); });

const ctxWith = (create: () => Promise<unknown>, retrieveName = "x", archived: string[] = []) => ({
  ids: {},
  client: { v1: { customers: {
    list: () => (async function* () { /* none */ })(),
    create,
    retrieve: async () => ({ data: { name: retrieveName } }),
    archive: async (p: { id: string }) => { archived.push(p.id); return { data: { id: p.id } }; },
  } } },
}) as unknown as Parameters<typeof H.createCustomerWithStripe>[0];

const apiError = (status: number, message: string) => Metronome.APIError.generate(status, { message }, message, new Headers());

describe("Metronome Trial limit (5 active customers) → clear demo-limit message", () => {
  it.each([
    ["404 masked (with Stripe link)", "The specified customer was not found"],
    ["explicit (without Stripe link)", "Trial accounts are limited to 5 active customers. To add more customers, contact Metronome's Sales team."],
  ])("%s", async (_, msg) => {
    const ctx = ctxWith(async () => { throw apiError(404, msg); });
    const p = H.createCustomerWithStripe(ctx, { name: "Nebula demo X", ingestAlias: "usr_x", stripeCustomerId: "cus_x" });
    await expect(p).rejects.toBeInstanceOf(DemoLimitError);
    await expect(p).rejects.toThrow(DEMO_LIMIT_MESSAGE);
  });
  it("other errors pass through unchanged", async () => {
    const ctx = ctxWith(async () => { throw apiError(400, "name is required"); });
    await expect(H.createCustomerWithStripe(ctx, { name: "", ingestAlias: "usr_y", stripeCustomerId: "cus_y" })).rejects.not.toBeInstanceOf(DemoLimitError);
  });
});

describe("admin archive: only Nebula demo customers", () => {
  it("prefix check", () => {
    expect(isArchivableDemoCustomer("Nebula demo probe")).toBe(true);
    expect(isArchivableDemoCustomer("Test Customer")).toBe(false);
    expect(isArchivableDemoCustomer("Demo Smoke Test")).toBe(false);
    expect(isArchivableDemoCustomer("nebula demo lower")).toBe(false);
  });
  it("live helper re-checks the name stored in Metronome and refuses others", async () => {
    const archived: string[] = [];
    await expect(H.archiveDemoCustomer(ctxWith(async () => ({}), "Test Customer", archived), "380eecf3")).rejects.toThrow(/Refusing to archive "Test Customer"/);
    expect(archived).toEqual([]);
    expect(await H.archiveDemoCustomer(ctxWith(async () => ({}), "Nebula demo probe", archived), "c51b")).toBe("Nebula demo probe");
    expect(archived).toEqual(["c51b"]);
  });
  it("mock: archives a Nebula demo customer, refuses any other", async () => {
    const other = await b.signup({ name: "Lucy", email: "l@x", plan: "free" });
    await expect(b.archiveDemoCustomer(other.customerId)).rejects.toThrow(/Only demo customers/);
    const demo = await b.signup({ name: "Nebula demo Lucy", email: "d@x", plan: "free" });
    expect((await b.archiveDemoCustomer(demo.customerId)).archived).toBe("Nebula demo Lucy");
    expect(getAccount(demo.customerId)).toBeNull();
    expect(getAccount(other.customerId)).not.toBeNull();
  });
});
