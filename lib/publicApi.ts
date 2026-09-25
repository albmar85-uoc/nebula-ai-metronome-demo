// API pública ficticia de nebula.ai (/api/v1/completions y /api/v1/images).
// Autentica por clave de API, devuelve una respuesta enlatada y registra el uso por el MISMO camino de facturación
// que el resto de la app (billing.ingest → /v1/ingest en vivo), con el id de la petición como transaction_id.
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticate } from "./apikeys";
import { billing } from "./billing";
import { balance } from "./billing/mock";
import { round2 } from "./billing/insights";
import { maxRequestCost, requestCost } from "./billing/limits";
import { PLANS } from "./catalog";
import type { UsageRequest } from "./billing/types";

export const MODELS = { text: "nebula-1", image: "nebula-image-1" } as const;
const IDEM_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

const err = (status: number, type: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: { type, message, ...extra } }, { status, headers: { "Cache-Control": "no-store" } });

/** Tokens estimados de un texto (≈ 4 caracteres por token). */
export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export type ParsedCall = { usage: UsageRequest; respond: (id: string) => Record<string, unknown> };

export function parseCompletion(body: Record<string, unknown>): ParsedCall | string {
  const model = body.model ?? MODELS.text;
  if (model !== MODELS.text) return `Model not available: use "${MODELS.text}"`;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "Missing \"prompt\" (text)";
  if (body.prompt.length > 200_000) return "\"prompt\" is too long (max 200,000 characters)";
  const max = body.max_tokens ?? 256;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 4096) return "\"max_tokens\" must be an integer between 1 and 4096";
  const inputTokens = estimateTokens(body.prompt), outputTokens = max as number;
  return {
    usage: { requestId: "", inputTokens, outputTokens, maxOutputTokens: max as number, model: MODELS.text },
    respond: id => ({
      id, object: "text_completion", created: Math.floor(Date.now() / 1000), model: MODELS.text,
      choices: [{ index: 0, text: "This is a simulated nebula-1 response. There is no real model in this demo: only usage is recorded.", finish_reason: "length" }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  };
}

export function parseImages(body: Record<string, unknown>): ParsedCall | string {
  const model = body.model ?? MODELS.image;
  if (model !== MODELS.image) return `Model not available: use "${MODELS.image}"`;
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return "Missing \"prompt\" (text)";
  const n = body.n ?? 1;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 10) return "\"n\" must be an integer between 1 and 10";
  const size = body.size ?? "1024x1024";
  if (size !== "512x512" && size !== "1024x1024") return "\"size\" must be 512x512 or 1024x1024";
  return {
    usage: { requestId: "", images: n as number, model: MODELS.image },
    respond: id => ({
      id, object: "image_generation", created: Math.floor(Date.now() / 1000), model: MODELS.image,
      data: Array.from({ length: n as number }, (_, i) => ({ url: `https://img.nebula.example/${id}/${i}.png`, size })),
      usage: { images: n },
    }),
  };
}

export async function handlePublicCall(req: Request, parse: (b: Record<string, unknown>) => ParsedCall | string) {
  const key = authenticate(req.headers);
  if (!key) return err(401, "authentication_error", "API key missing, invalid or revoked. Use \"Authorization: Bearer nbl_…\".");
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return err(400, "invalid_request_error", "The body must be JSON"); }
  if (!body || typeof body !== "object") return err(400, "invalid_request_error", "The body must be a JSON object");
  const parsed = parse(body);
  if (typeof parsed === "string") return err(400, "invalid_request_error", parsed);
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !IDEM_RE.test(idem)) return err(400, "invalid_request_error", "Idempotency-Key: 1-100 characters [A-Za-z0-9_.:-]");
  // Id de la petición de la app = transaction_id en Metronome. Con Idempotency-Key, los reintentos no se cobran dos veces.
  const requestId = idem ? `idem_${idem}` : `req_${randomUUID()}`;
  const usage: UsageRequest = { ...parsed.usage, requestId, source: "api" };
  let r;
  try { r = await billing.ingest(key.customerKey, [usage]); }
  catch (e) { return err(404, "not_found", (e as Error).message); }
  if (r.rejected) {
    if (r.reason === "insufficient_balance") {
      const worst = round2(maxRequestCost(usage, PLANS[r.account.plan].discount) * 10000) / 10000;
      const bal = round2(balance(r.account));
      return err(402, "insufficient_balance", `Insufficient balance: this request could cost up to €${worst.toFixed(4)} and your balance is €${bal.toFixed(2)}. Your plan never bills beyond your balance, so the request was not run. Lower max_tokens, top up or upgrade.`, { balance_eur: bal, max_cost_eur: worst });
    }
    return r.reason === "spend_cap"
      ? err(402, "spend_limit_reached", "You've reached your monthly spend limit. Raise it in Billing or wait for the next period.", { spend_cap_eur: r.account.spendCap?.monthlyEur })
      : err(402, "insufficient_balance", "Balance used up: API access is paused. Top up or upgrade.", { balance_eur: balance(r.account) });
  }
  const replay = r.duplicates > 0;
  const cost = round2(requestCost(usage, PLANS[r.account.plan].discount) * 10000) / 10000;
  return NextResponse.json(
    { ...parsed.respond(requestId), billing: { request_id: requestId, cost_eur: replay ? 0 : cost, balance_eur: round2(balance(r.account)), replayed: replay } },
    { headers: { "X-Request-Id": requestId, "Cache-Control": "no-store", ...(replay ? { "Idempotent-Replayed": "true" } : {}) } },
  );
}
