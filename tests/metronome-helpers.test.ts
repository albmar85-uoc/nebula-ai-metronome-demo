// Paridad con el paquete del experto: los cuerpos que construye el port (SDK) deben ser IDÉNTICOS a los que imprime
// /workspace/metronome-setup/dry-run-helpers.txt (generados por sus helpers con IDs ficticios).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as H from "@/lib/billing/metronome-helpers";
import { fromEnv, loadMetronomeIds, promotionFromIds, type MetronomeIds } from "@/lib/billing/metronome-config";
import { buildIngestEvents, mapGrant, mapInvoice } from "@/lib/billing/metronome";
import type Metronome from "@metronome/sdk";

const SETUP = "/workspace/metronome-setup";
const hasSetup = fs.existsSync(path.join(SETUP, "dry-run-helpers.txt"));
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const CONTRACT = "22222222-2222-4222-8222-222222222222";

type Call = { method: string; path: string; body?: any };
function parseDryRun(): Record<string, Call[]> {
  const txt = fs.readFileSync(path.join(SETUP, "dry-run-helpers.txt"), "utf8");
  const out: Record<string, Call[]> = {};
  for (const sec of txt.split(/\n=+ (.+?) =+\n/).slice(1).reduce<string[][]>((acc, x, i, arr) => (i % 2 === 0 ? [...acc, [x, arr[i + 1]]] : acc), [])) {
    const [title, body] = sec;
    const calls: Call[] = [];
    const re = /→ \[dry-run\] (GET|POST) https:\/\/api\.metronome\.com([^\s?]+)\S*\n(\{[\s\S]*?\n\}|\[[\s\S]*?\n\])?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) calls.push({ method: m[1], path: m[2], body: m[3] ? JSON.parse(m[3]) : undefined });
    out[title.split(".")[0].trim()] = calls;
  }
  return out;
}

describe.skipIf(!hasSetup)("parity with the setup helpers (dry-run-helpers.txt)", () => {
  const ids = JSON.parse(fs.readFileSync(path.join(SETUP, "metronome-ids.dry-run.json"), "utf8")) as MetronomeIds;
  const ctx = { client: null as unknown as Metronome, ids };
  const S = hasSetup ? parseDryRun() : {};
  const post = (sec: string, p: string, n = 0) => S[sec].filter(c => c.method === "POST" && c.path === p)[n].body;

  it("POST /v1/customers", () => {
    expect(H.buildCreateCustomerBody({ name: "Ada Lovelace", ingestAlias: "user_123", stripeCustomerId: "cus_TEST123" })).toEqual(post("1", "/v1/customers"));
  });
  it.each([["2a", "free", {}], ["2b", "pro", { autoRecharge: true }], ["2c", "scale", { spendThreshold: true }]] as const)("contrato %s (%s)", (sec, plan, extra) => {
    expect(H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan, startingAt: "2026-09-25T18:00:00.000Z", ...extra })).toEqual(post(sec, "/v1/contracts/create"));
  });
  it("upgrade Pro → Scale = immediate RENEWAL transition anchored to the previous contract", () => {
    const want = post("3", "/v1/contracts/create");
    const body = H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan: "scale", startingAt: H.floorToHour(new Date("2026-09-25T18:22:00Z")), billingAnchorDate: "2026-09-03T10:00:00.000Z", fromContractId: CONTRACT, autoRecharge: true });
    expect(body).toEqual(want);
    expect(body.transition).toEqual({ type: "RENEWAL", from_contract_id: CONTRACT });
  });
  it("downgrade Pro → Free = transition at the start of the next period", () => {
    const startingAt = H.nextPeriodStart("2026-09-03T10:00:00.000Z", new Date("2026-09-25T18:22:00Z"));
    expect(startingAt).toBe("2026-10-03T10:00:00.000Z");
    expect(H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan: "free", startingAt, billingAnchorDate: "2026-09-03T10:00:00.000Z", fromContractId: CONTRACT })).toEqual(post("3b", "/v1/contracts/create"));
  });
  it("bundle: commit with payment gate and, separately, the bonus (uniqueness_key by purchase id)", () => {
    const commit = post("4", "/v2/contracts/edit", 0);
    const now = new Date(commit.add_commits[0].access_schedule.schedule_items[0].starting_at);
    expect(H.buildBundleCommitEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, bundle: "b200", purchaseId: "pur_demo_001", now })).toEqual(commit);
    expect(H.buildBundleBonusEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, bundle: "b200", purchaseId: "pur_demo_001", now })).toEqual(post("4", "/v2/contracts/edit", 1));
    expect(commit.uniqueness_key).toBe("nebula-bundle-pur_demo_001");
  });
  it("20% alert per plan", () => {
    expect(H.buildLowBalanceAlertBody(ctx, CUSTOMER, "pro")).toEqual(post("6", "/v1/alerts/create"));
  });
  it("expiring promo credit (WELCOME10, same code in the setup and the web app)", () => {
    const want = post("9", "/v2/contracts/edit");
    const now = new Date(want.add_credits[0].access_schedule.schedule_items[0].starting_at);
    expect(H.buildPromoCreditEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, code: "WELCOME10", label: "Welcome bonus", amountEur: 10, validDays: 30, now })).toEqual(want);
  });
  it("ingest: same event shape as llmRequestEvent / imageGenerationEvent", () => {
    const events = S["7"].find(c => c.path === "/v1/ingest")!.body as any[];
    const llm = events.find(e => e.event_type === "nebula_llm_request");
    const img = events.find(e => e.event_type === "nebula_image_generation");
    expect(H.llmRequestEvent(ctx, { transactionId: llm.transaction_id, customer: llm.customer_id, inputTokens: llm.properties.input_tokens, outputTokens: llm.properties.output_tokens, model: llm.properties.model, timestamp: llm.timestamp })).toEqual(llm);
    expect(H.imageGenerationEvent(ctx, { transactionId: img.transaction_id, customer: img.customer_id, images: img.properties.images, model: img.properties.model, timestamp: img.timestamp })).toEqual(img);
  });
  // Fake client mirroring the setup's dry-run responder: records calls and returns simulated contracts.
  const SCALE_CONTRACT = "33333333-3333-4333-8333-333333333333";
  const ANCHOR = { frequency: "MONTHLY", billing_anchor_date: "2026-09-03T10:00:00.000Z" };
  const AR = (commit: object = { duration: { value: "12", unit: "MONTHS" }, rollover_fraction: 1, rate_type: "LIST_RATE" }) => ({ is_enabled: true, threshold_amount: 10, recharge_to_amount: 50, commit });
  const proContract = (commit?: object) => ({ id: CONTRACT, customer_id: CUSTOMER, starting_at: "2026-09-03T10:00:00.000Z", custom_fields: { nebula_plan: "pro" }, usage_statement_schedule: ANCHOR, prepaid_balance_threshold_configuration: AR(commit ?? { duration: { value: "12", unit: "MONTHS" }, rollover_fraction: 1 }), spend_threshold_configuration: null });
  const legacyScale = { id: SCALE_CONTRACT, customer_id: CUSTOMER, starting_at: "2026-09-03T10:00:00.000Z", custom_fields: { nebula_plan: "scale" }, usage_statement_schedule: ANCHOR, prepaid_balance_threshold_configuration: AR(), spend_threshold_configuration: null };
  const fake = (opts: { pro?: Record<string, unknown>; newId?: string } = {}) => {
    const calls: { op: string; body: any }[] = [];
    const get = (id: string) => id === SCALE_CONTRACT ? legacyScale : id === CONTRACT ? (opts.pro ?? proContract())
      : { id, customer_id: CUSTOMER, starting_at: "2026-09-25T19:00:00.000Z", custom_fields: { nebula_plan: "scale" }, prepaid_balance_threshold_configuration: null, spend_threshold_configuration: null };
    const client = {
      v1: { contracts: { create: async (body: any) => { calls.push({ op: "create", body }); return { data: { id: opts.newId ?? "44444444-4444-4444-8444-444444444444" } }; } } },
      v2: { contracts: {
        list: async (body: any) => { calls.push({ op: "list", body }); return { data: [opts.pro ?? proContract()] }; },
        retrieve: async (body: any) => { calls.push({ op: "get", body }); return { data: get(body.contract_id) }; },
        edit: async (body: any) => { calls.push({ op: "edit", body }); return { data: { id: body.contract_id } }; },
      } },
    } as unknown as Metronome;
    return { ctx: { client, ids }, calls };
  };
  const posts = (sec: string, p: string) => S[sec].filter(c => c.method === "POST" && c.path === p).map(c => c.body);
  const ops = (calls: { op: string; body: any }[]) => calls.filter(x => x.op !== "list").map(x => [x.op, x.body]);

  it("3a: next-hour upgrade is created WITHOUT threshold billing; both are added in ONE edit once it starts", async () => {
    const newId = post("3a", "/v2/contracts/get").contract_id;
    const { ctx: c, calls } = fake({ newId });
    const res = await H.changePlan(c, CUSTOMER, "scale", { now: new Date("2026-09-25T18:22:00Z"), upgradeStart: "next_hour" });
    const created = calls.find(x => x.op === "create")!.body;
    expect(created).toEqual(post("3a", "/v1/contracts/create"));
    expect(created.prepaid_balance_threshold_configuration).toBeUndefined();
    expect(created.spend_threshold_configuration).toBeUndefined();
    expect(res).toMatchObject({ kind: "upgrade", effectiveAt: "2026-09-25T19:00:00.000Z", pendingThresholdConfig: "auto_recharge_and_spend_threshold" });
    // Before the start: no API call.
    expect(await H.finishPendingThresholdConfig(c, CUSTOMER, res, new Date("2026-09-25T18:59:00Z"))).toEqual({ done: false, applied: false, retryAt: "2026-09-25T19:00:00.000Z" });
    const n = calls.length;
    expect(await H.finishPendingThresholdConfig(c, CUSTOMER, res, new Date("2026-09-25T19:05:00Z"))).toEqual({ done: true, applied: true });
    expect(ops(calls.slice(n))).toEqual([["get", post("3a", "/v2/contracts/get")], ["edit", post("3a", "/v2/contracts/edit")]]);
  });
  it("3c: a Scale contract with auto-recharge always includes the €300 spend threshold too", async () => {
    const body = H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan: "scale", startingAt: "2026-09-25T18:00:00.000Z", autoRecharge: true, now: new Date("2026-09-25T18:22:00Z") });
    expect(body).toEqual(post("3c", "/v1/contracts/create"));
    expect(body.spend_threshold_configuration).toMatchObject({ is_enabled: true, threshold_amount: 300, payment_gate_config: { payment_gate_type: "STRIPE", stripe_config: { payment_type: "PAYMENT_INTENT" } } });
    expect(body.prepaid_balance_threshold_configuration).toBeDefined();
  });
  it("3d: future Scale signup omits thresholds; the spend threshold is added once it starts", async () => {
    const newId = post("3d", "/v2/contracts/get").contract_id;
    const { ctx: c, calls } = fake({ newId });
    const r = await H.createPlanContractWithPending(c, { customerId: CUSTOMER, plan: "scale", startingAt: "2026-10-01T00:00:00.000Z", now: new Date("2026-09-25T18:22:00Z") });
    expect(r).toEqual({ newContractId: newId, effectiveAt: "2026-10-01T00:00:00.000Z", pendingThresholdConfig: "spend_threshold" });
    await H.finishPendingThresholdConfig(c, CUSTOMER, r, new Date("2026-10-01T00:05:00Z"));
    expect(ops(calls)).toEqual([["create", post("3d", "/v1/contracts/create")], ["get", post("3d", "/v2/contracts/get")], ["edit", post("3d", "/v2/contracts/edit")]]);
  });
  it("5: auto-recharge disable / enable (update_ carries the commit terms inside commit)", async () => {
    const { ctx: c, calls } = fake();
    await H.setAutoRecharge(c, CUSTOMER, CONTRACT, false);
    await H.setAutoRecharge(c, CUSTOMER, CONTRACT, true);
    expect(calls.filter(x => x.op === "edit").map(x => x.body)).toEqual(posts("5", "/v2/contracts/edit"));
  });
  it("5a: on a legacy Scale contract without spend threshold, toggling auto-recharge adds the €300 threshold in the same edit (never disables it)", async () => {
    const { ctx: c, calls } = fake();
    await H.setAutoRecharge(c, CUSTOMER, SCALE_CONTRACT, false);
    await H.setAutoRecharge(c, CUSTOMER, SCALE_CONTRACT, true);
    const edits = calls.filter(x => x.op === "edit").map(x => x.body);
    expect(edits).toEqual(posts("5a", "/v2/contracts/edit"));
    for (const e of edits) expect(e.update_spend_threshold_configuration?.is_enabled).not.toBe(false);
  });
  it("5b: sync only the recharge-commit terms (no is_enabled); no-op when already up to date", async () => {
    const { ctx: c, calls } = fake();
    await H.syncAutoRechargeCommitTerms(c, CUSTOMER, CONTRACT);
    expect(ops(calls)).toEqual([["get", post("5b", "/v2/contracts/get")], ["edit", post("5b", "/v2/contracts/edit")]]);
    // The API returns duration.value as a string: normalized with Number(), not re-edited.
    const up = fake({ pro: proContract({ duration: { value: "12", unit: "MONTHS" }, rollover_fraction: 1, rate_type: "LIST_RATE" }) });
    expect(await H.buildAutoRechargeCommitTermsEdit(up.ctx, CUSTOMER, CONTRACT)).toBeUndefined();
    expect(H.summarizeContract(legacyScale as any).autoRecharge).toMatchObject({ commitDuration: { value: 12, unit: "MONTHS" }, rolloverFraction: 1, rateType: "LIST_RATE" });
  });
  it("10b: spend threshold on a Scale contract that also has auto-recharge (they coexist); turning it off on Scale is refused", async () => {
    const { ctx: c, calls } = fake();
    await H.setSpendThreshold(c, CUSTOMER, SCALE_CONTRACT, true);
    expect(ops(calls)).toEqual([["get", post("10b", "/v2/contracts/get")], ["edit", post("10b", "/v2/contracts/edit")]]);
    await expect(H.setSpendThreshold(c, CUSTOMER, SCALE_CONTRACT, false)).rejects.toThrow("always on for the Scale plan");
  });
  it("30-day usage: window at UTC midnight and the 3 metrics", () => {
    const want = post("12", "/v1/usage");
    const got = H.buildUsageLast30DaysBody(ctx, CUSTOMER, new Date(new Date(want.ending_before).getTime() - 3600_000));
    expect(got).toEqual(want);
  });
});

describe("idempotent ingest with the app's request id", () => {
  const ids = { event_types: { input_tokens: "nebula_llm_request", output_tokens: "nebula_llm_request", images: "nebula_image_generation" }, event_properties: { input_tokens: "input_tokens", output_tokens: "output_tokens", images: "images" } } as unknown as MetronomeIds;
  const ctx = { client: null as unknown as Metronome, ids };
  it("transaction_id = requestId; requests are not merged; text+images → deterministic suffix", () => {
    const a = buildIngestEvents(ctx, "usr_1", { requestId: "req-A", inputTokens: 10, outputTokens: 5, ts: "2026-09-25T10:00:00.000Z" });
    const b = buildIngestEvents(ctx, "usr_1", { requestId: "req-B", images: 2, ts: "2026-09-25T10:00:01.000Z" });
    const c = buildIngestEvents(ctx, "usr_1", { requestId: "req-C", inputTokens: 1, images: 1 });
    expect(a).toEqual([{ transaction_id: "req-A", customer_id: "usr_1", event_type: "nebula_llm_request", timestamp: "2026-09-25T10:00:00.000Z", properties: { input_tokens: 10, output_tokens: 5, model: "nebula-1" } }]);
    expect(b.map(e => e.transaction_id)).toEqual(["req-B"]);
    expect(c.map(e => e.transaction_id)).toEqual(["req-C", "req-C:images"]);
    // Determinista: repetir la misma petición produce exactamente los mismos eventos (Metronome deduplica 34 días).
    expect(buildIngestEvents(ctx, "usr_1", { requestId: "req-A", inputTokens: 10, outputTokens: 5, ts: "2026-09-25T10:00:00.000Z" })).toEqual(a);
  });
});

describe("webhooks → action (interpretWebhook)", () => {
  it("threshold 0 ⇒ cut off; >0 ⇒ offer top-up; payment_gate.* ⇒ payment actions", () => {
    const alert = (threshold: number) => ({ id: "x", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: "c", threshold, remaining_balance: 3 } });
    expect(H.interpretWebhook(alert(0))).toEqual({ action: "cut_access", customerId: "c" });
    expect(H.interpretWebhook(alert(6))).toEqual({ action: "offer_top_up", customerId: "c", remainingEur: 3 });
    expect(H.interpretWebhook({ id: "y", type: "payment_gate.threshold_reached", properties: { customer_id: "c", contract_id: "k", workflow_type: "spend" } })).toMatchObject({ action: "threshold_charge_started", workflowType: "spend" });
    expect(H.interpretWebhook({ id: "z", type: "payment_gate.payment_status", properties: { customer_id: "c", contract_id: "k", payment_status: "failed", workflow_type: "spend" } })).toMatchObject({ action: "payment_failed" });
    expect(H.interpretWebhook({ id: "w", type: "contract.edit", properties: {} })).toEqual({ action: "ignore" });
  });
});

describe("next-invoice preview from DRAFT invoices", () => {
  it("only DRAFT USAGE for the current period; sums charges and applied credits", () => {
    const inv = (id: string, start: string, end: string, type = "USAGE") => ({
      id, status: "DRAFT", type, periodStart: start, periodEnd: end, totalEur: 12, currency: "EUR",
      lines: [{ name: "Tokens", type: "usage", totalEur: 20 }, { name: "Fee", type: "subscription", totalEur: 29 }, { name: "Credits", type: "applied_commit_or_credit", totalEur: -37 }],
    });
    const p = H.previewFromDrafts("c", [inv("cur", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"), inv("fut", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), inv("sch", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "SCHEDULED")], "k", "2026-09-25T12:00:00Z");
    expect(p).toMatchObject({ grossChargesEur: 49, creditsAppliedEur: 37, totalDueEur: 12, draftInvoiceIds: ["cur"] });
  });
});

describe("UI mappings", () => {
  it("CreditGrantView → CreditGrant and InvoiceView → Invoice", () => {
    expect(mapGrant({ id: "g", kind: "bundle_bonus", metronomeType: "CREDIT", name: "Bonus", productId: "p", grantedEur: 30, remainingEur: 12, expiresAt: "2027-09-01T00:00:00Z", reference: "pur_1" }))
      .toMatchObject({ kind: "gift", amount: 30, remaining: 12, reference: "pur_1" });
    expect(mapGrant({ id: "g", kind: "promo", metronomeType: "CREDIT", name: "P", productId: "p", grantedEur: 10, remainingEur: 10 }).kind).toBe("promo");
    const i = mapInvoice({ id: "i", status: "FINALIZED", type: "USAGE", totalEur: 40, currency: "EUR", lines: [{ name: "x", type: "usage", totalEur: 40 }], stripeStatus: "paid" });
    expect(i).toMatchObject({ status: "paid", type: "usage", amount: 40 });
    expect(mapInvoice({ id: "d", status: "DRAFT", type: "USAGE", totalEur: 1, currency: "EUR", lines: [] }).status).toBe("draft");
  });
});

describe("loading metronome-ids.json (setup format)", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const write = (obj: unknown) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ids-")), "metronome-ids.json"); fs.writeFileSync(f, JSON.stringify(obj)); process.env.METRONOME_IDS_FILE = f; return f; };
  it.skipIf(!hasSetup)("reads the setup format and rejects a dry-run file", () => {
    const dry = JSON.parse(fs.readFileSync(path.join(SETUP, "metronome-ids.dry-run.json"), "utf8"));
    write(dry);
    expect(() => loadMetronomeIds()).toThrow(/dry run/);
    write({ ...dry, dry_run: false, generated_at: "2026-09-25T19:00:00Z" });
    const ids = loadMetronomeIds();
    expect(ids.products.fixed.bundle_commit).toBe(dry.products.fixed.bundle_commit);
    expect(ids.auto_recharge.recharge_to_eur).toBe(50);
    expect(ids.amount_scale).toBe(1);
    // display_name por plan/bundle y lista de promociones del setup
    expect(ids.catalog.plans.pro.display_name).toBe("Pro");
    expect(ids.catalog.bundles.b200.display_name).toBe("€200 bundle (+€30 bonus)");
    expect(promotionFromIds(ids, " welcome10 ")).toMatchObject({ code: "WELCOME10", label: "Welcome bonus", amount: 10, validDays: 30 });
    expect(promotionFromIds(ids, "BIENVENIDA10")).toBeUndefined();
    // un fichero antiguo sin catalog.promotions/display_name se completa con el catálogo de la web
    write({ ...dry, dry_run: false, generated_at: "2026-09-25T19:01:00Z", catalog: { plans: {}, bundles: {} } });
    const old = loadMetronomeIds();
    expect(old.catalog.plans.scale.display_name).toBe("Scale");
    expect(Object.keys(old.catalog.promotions)).toEqual(["WELCOME10", "LAUNCH25"]);
  });
  it("the web catalog matches the setup's (plans, bundles with display_name, promotions)", () => {
    const dry = JSON.parse(fs.readFileSync(path.join(SETUP, "metronome-ids.dry-run.json"), "utf8"));
    process.env.METRONOME_IDS_FILE = "/no/existe.json";
    const web = fromEnv({} as NodeJS.ProcessEnv);
    for (const k of ["free", "pro", "scale"] as const) { const { subscription_product_id: _s, ...want } = dry.catalog.plans[k]; expect(web.catalog.plans[k]).toEqual(want); }
    expect(web.catalog.bundles).toEqual(dry.catalog.bundles);
    expect(web.catalog.promotions).toEqual(dry.catalog.promotions);
    expect(web.auto_recharge).toEqual({ threshold_eur: 10, recharge_to_eur: 50 }); // valor por defecto sin fichero de IDs
  });
  it("without a file, builds the same object from environment variables; if any are missing, lists them", () => {
    process.env.METRONOME_IDS_FILE = "/no/existe.json";
    expect(() => loadMetronomeIds()).toThrow(/credit_types\.EUR/);
    Object.assign(process.env, {
      METRONOME_CREDIT_TYPE_ID: "eur", METRONOME_RATE_CARD_ID: "rc",
      METRONOME_METRIC_INPUT_TOKENS: "m1", METRONOME_METRIC_OUTPUT_TOKENS: "m2", METRONOME_METRIC_IMAGES: "m3",
      METRONOME_PRODUCT_INPUT_TOKENS: "p1", METRONOME_PRODUCT_OUTPUT_TOKENS: "p2", METRONOME_PRODUCT_IMAGES: "p3",
      METRONOME_PRODUCT_SUBSCRIPTION_PRO: "sp", METRONOME_PRODUCT_SUBSCRIPTION_SCALE: "ss",
      METRONOME_PRODUCT_PLAN_CREDITS: "f1", METRONOME_PRODUCT_BUNDLE_COMMIT: "f2", METRONOME_PRODUCT_BUNDLE_BONUS: "f3", METRONOME_PRODUCT_AUTO_RECHARGE: "f4",
      METRONOME_PRODUCT_SPEND_THRESHOLD: "f5", METRONOME_PRODUCT_PROMO_CREDIT: "f6", METRONOME_PRODUCT_ENTERPRISE_COMMIT: "f7",
    });
    const ids = loadMetronomeIds();
    expect(ids.products.usage.images).toBe("p3");
    expect(ids.products.fixed.promo_credit).toBe("f6");
    expect(ids._source).toBe("environment variables");
  });
});
