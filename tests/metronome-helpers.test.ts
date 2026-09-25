// Paridad con el paquete del experto: los cuerpos que construye el port (SDK) deben ser IDÉNTICOS a los que imprime
// /workspace/metronome-setup/dry-run-helpers.txt (generados por sus helpers con IDs ficticios).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as H from "@/lib/billing/metronome-helpers";
import { loadMetronomeIds, type MetronomeIds } from "@/lib/billing/metronome-config";
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

describe.skipIf(!hasSetup)("paridad con los helpers del setup (dry-run-helpers.txt)", () => {
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
  it("subida Pro → Scale = transición RENEWAL inmediata con el ancla del contrato anterior", () => {
    const want = post("3", "/v1/contracts/create");
    const body = H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan: "scale", startingAt: H.floorToHour(new Date("2026-09-25T18:22:00Z")), billingAnchorDate: "2026-09-03T10:00:00.000Z", fromContractId: CONTRACT, autoRecharge: true });
    expect(body).toEqual(want);
    expect(body.transition).toEqual({ type: "RENEWAL", from_contract_id: CONTRACT });
  });
  it("bajada Pro → Free = transición al inicio del siguiente periodo", () => {
    const startingAt = H.nextPeriodStart("2026-09-03T10:00:00.000Z", new Date("2026-09-25T18:22:00Z"));
    expect(startingAt).toBe("2026-10-03T10:00:00.000Z");
    expect(H.buildPlanContractBody(ctx, { customerId: CUSTOMER, plan: "free", startingAt, billingAnchorDate: "2026-09-03T10:00:00.000Z", fromContractId: CONTRACT })).toEqual(post("3b", "/v1/contracts/create"));
  });
  it("bundle: commit con payment gate y, aparte, el bonus (uniqueness_key por id de compra)", () => {
    const commit = post("4", "/v2/contracts/edit", 0);
    const now = new Date(commit.add_commits[0].access_schedule.schedule_items[0].starting_at);
    expect(H.buildBundleCommitEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, bundle: "b200", purchaseId: "pur_demo_001", now })).toEqual(commit);
    expect(H.buildBundleBonusEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, bundle: "b200", purchaseId: "pur_demo_001", now })).toEqual(post("4", "/v2/contracts/edit", 1));
    expect(commit.uniqueness_key).toBe("nebula-bundle-pur_demo_001");
  });
  it("alerta del 20 % por plan", () => {
    expect(H.buildLowBalanceAlertBody(ctx, CUSTOMER, "pro")).toEqual(post("6", "/v1/alerts/create"));
  });
  it("crédito promocional con caducidad (WELCOME del setup = BIENVENIDA10 de la web)", () => {
    const want = post("9", "/v2/contracts/edit");
    const now = new Date(want.add_credits[0].access_schedule.schedule_items[0].starting_at);
    expect(H.buildPromoCreditEdit(ctx, { customerId: CUSTOMER, contractId: CONTRACT, code: "WELCOME", label: "Bono de bienvenida", amountEur: 10, validDays: 30, now })).toEqual(want);
  });
  it("ingesta: mismo formato de evento que llmRequestEvent / imageGenerationEvent", () => {
    const events = S["7"].find(c => c.path === "/v1/ingest")!.body as any[];
    const llm = events.find(e => e.event_type === "nebula_llm_request");
    const img = events.find(e => e.event_type === "nebula_image_generation");
    expect(H.llmRequestEvent(ctx, { transactionId: llm.transaction_id, customer: llm.customer_id, inputTokens: llm.properties.input_tokens, outputTokens: llm.properties.output_tokens, model: llm.properties.model, timestamp: llm.timestamp })).toEqual(llm);
    expect(H.imageGenerationEvent(ctx, { transactionId: img.transaction_id, customer: img.customer_id, images: img.properties.images, model: img.properties.model, timestamp: img.timestamp })).toEqual(img);
  });
  it("uso de 30 días: ventana a medianoche UTC y las 3 métricas", () => {
    const want = post("12", "/v1/usage");
    const got = H.buildUsageLast30DaysBody(ctx, CUSTOMER, new Date(new Date(want.ending_before).getTime() - 3600_000));
    expect(got).toEqual(want);
  });
});

describe("ingesta idempotente con el id de petición de la app", () => {
  const ids = { event_types: { input_tokens: "nebula_llm_request", output_tokens: "nebula_llm_request", images: "nebula_image_generation" }, event_properties: { input_tokens: "input_tokens", output_tokens: "output_tokens", images: "images" } } as unknown as MetronomeIds;
  const ctx = { client: null as unknown as Metronome, ids };
  it("transaction_id = requestId; no fusiona peticiones; texto+imágenes → sufijo determinista", () => {
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

describe("webhooks → acción (interpretWebhook)", () => {
  it("umbral 0 ⇒ cortar; >0 ⇒ ofrecer recarga; payment_gate.* ⇒ acciones de pago", () => {
    const alert = (threshold: number) => ({ id: "x", type: "alerts.low_remaining_contract_credit_and_commit_balance_reached", properties: { customer_id: "c", threshold, remaining_balance: 3 } });
    expect(H.interpretWebhook(alert(0))).toEqual({ action: "cut_access", customerId: "c" });
    expect(H.interpretWebhook(alert(6))).toEqual({ action: "offer_top_up", customerId: "c", remainingEur: 3 });
    expect(H.interpretWebhook({ id: "y", type: "payment_gate.threshold_reached", properties: { customer_id: "c", contract_id: "k", workflow_type: "spend" } })).toMatchObject({ action: "threshold_charge_started", workflowType: "spend" });
    expect(H.interpretWebhook({ id: "z", type: "payment_gate.payment_status", properties: { customer_id: "c", contract_id: "k", payment_status: "failed", workflow_type: "spend" } })).toMatchObject({ action: "payment_failed" });
    expect(H.interpretWebhook({ id: "w", type: "contract.edit", properties: {} })).toEqual({ action: "ignore" });
  });
});

describe("vista previa de la próxima factura a partir de facturas DRAFT", () => {
  it("solo DRAFT USAGE del periodo en curso; suma cargos y créditos aplicados", () => {
    const inv = (id: string, start: string, end: string, type = "USAGE") => ({
      id, status: "DRAFT", type, periodStart: start, periodEnd: end, totalEur: 12, currency: "EUR",
      lines: [{ name: "Tokens", type: "usage", totalEur: 20 }, { name: "Cuota", type: "subscription", totalEur: 29 }, { name: "Créditos", type: "applied_commit_or_credit", totalEur: -37 }],
    });
    const p = H.previewFromDrafts("c", [inv("cur", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"), inv("fut", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), inv("sch", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "SCHEDULED")], "k", "2026-09-25T12:00:00Z");
    expect(p).toMatchObject({ grossChargesEur: 49, creditsAppliedEur: 37, totalDueEur: 12, draftInvoiceIds: ["cur"] });
  });
});

describe("mapeos a la UI", () => {
  it("CreditGrantView → CreditGrant y InvoiceView → Invoice", () => {
    expect(mapGrant({ id: "g", kind: "bundle_bonus", metronomeType: "CREDIT", name: "Bonus", productId: "p", grantedEur: 30, remainingEur: 12, expiresAt: "2027-09-01T00:00:00Z", reference: "pur_1" }))
      .toMatchObject({ kind: "gift", amount: 30, remaining: 12, reference: "pur_1" });
    expect(mapGrant({ id: "g", kind: "promo", metronomeType: "CREDIT", name: "P", productId: "p", grantedEur: 10, remainingEur: 10 }).kind).toBe("promo");
    const i = mapInvoice({ id: "i", status: "FINALIZED", type: "USAGE", totalEur: 40, currency: "EUR", lines: [{ name: "x", type: "usage", totalEur: 40 }], stripeStatus: "paid" });
    expect(i).toMatchObject({ status: "paid", type: "usage", amount: 40 });
    expect(mapInvoice({ id: "d", status: "DRAFT", type: "USAGE", totalEur: 1, currency: "EUR", lines: [] }).status).toBe("draft");
  });
});

describe("carga de metronome-ids.json (formato del setup)", () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const write = (obj: unknown) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ids-")), "metronome-ids.json"); fs.writeFileSync(f, JSON.stringify(obj)); process.env.METRONOME_IDS_FILE = f; return f; };
  it.skipIf(!hasSetup)("lee el formato del setup y rechaza un fichero de dry-run", () => {
    const dry = JSON.parse(fs.readFileSync(path.join(SETUP, "metronome-ids.dry-run.json"), "utf8"));
    write(dry);
    expect(() => loadMetronomeIds()).toThrow(/dry-run/);
    write({ ...dry, dry_run: false, generated_at: "2026-09-25T19:00:00Z" });
    const ids = loadMetronomeIds();
    expect(ids.products.fixed.bundle_commit).toBe(dry.products.fixed.bundle_commit);
    expect(ids.auto_recharge.recharge_to_eur).toBe(50);
    expect(ids.amount_scale).toBe(1);
  });
  it("sin fichero, construye el mismo objeto con variables de entorno; si faltan, dice cuáles", () => {
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
    expect(ids._source).toBe("variables de entorno");
  });
});
