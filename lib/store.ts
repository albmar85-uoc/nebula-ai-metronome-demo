// Almacén local basado en un fichero JSON (./data/db.json por defecto, configurable con DATA_DIR).
// Suficiente para una demo con un único proceso de Next.js: se carga una vez y se reescribe
// de forma atómica (fichero temporal + rename) en cada cambio.
import fs from "node:fs";
import path from "node:path";
import type { Account, Actor, Alert, UsageEvent } from "./billing/types";
import type { BundleId, PlanId } from "./catalog";

/** Enlace entre el usuario de la app y sus IDs externos (modo en vivo). */
export type CustomerLink = {
  appUserId: string; // id local (el que va en la cookie)
  name: string;
  email: string;
  plan: PlanId;
  pendingPlan?: { plan: PlanId; effectiveAt: string; contractId: string };
  accessCut?: boolean; // webhook de saldo 0 (Free/Pro) o pago de umbral fallido; se levanta al confirmarse un pago
  accessCutAt?: string;
  metronomeCustomerId: string;
  metronomeContractId: string;
  stripeCustomerId?: string;
  spendCap?: import("./billing/types").SpendCap; // límite de gasto del cliente (lo aplica la app)
  createdAt: string;
};

/** Clave de API por usuario. Solo se guarda el hash (SHA-256 con pimienta opcional); el secreto se muestra una vez. */
export type ApiKey = {
  id: string;
  customerKey: string; // id de sesión (cuenta simulada o appUserId en vivo)
  name: string;
  prefix: string; // primeros caracteres visibles, p. ej. "nbl_test_3f9a"
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

/** Historial de plan/contrato (lo registra la app en ambos modos). */
export type PlanEvent = { ts: string; kind: "signup" | "upgrade" | "downgrade_scheduled" | "downgrade_applied" | "downgrade_cancelled"; from?: PlanId; to: PlanId; actor: Actor; effectiveAt?: string; contractId?: string };
export type AdminLogEntry = { id: string; ts: string; customerKey: string; action: string; detail: string };

/** Compra de bundle: el regalo se concede solo tras payment_gate.payment_status = paid, emparejando por purchaseId. */
export type Purchase = {
  purchaseId: string;
  customerKey: string; // id de cuenta simulada o id de cliente de Metronome
  contractId: string;
  bundle: BundleId;
  status: "payment_pending" | "bonus_granted" | "failed";
  createdAt: string;
  resolvedAt?: string;
};

type DB = {
  version: 1;
  accounts: Record<string, Account>; // modo simulado
  links: Record<string, CustomerLink>; // modo en vivo: appUserId -> IDs externos
  alerts: Record<string, Alert[]>; // alertas recibidas por webhook, por id de cliente (Metronome o local)
  usage: Record<string, UsageEvent[]>; // modo en vivo: copia local de los eventos enviados (para gráficas)
  purchases: Purchase[]; // compras de bundles (regalo pendiente de confirmación de pago)
  seenWebhooks: { id: string; ts: string }[]; // deduplicación de webhooks por id (persistida en disco)
  seenRequests: Record<string, string[]>; // modo en vivo: ids de petición ya enviados a /v1/ingest por usuario
  enterpriseLeads: { id: string; ts: string; company: string; email: string; monthlySpend: number }[];
  apiKeys: ApiKey[];
  planHistory: Record<string, PlanEvent[]>;
  adminLog: AdminLogEntry[];
};

const empty = (): DB => ({ version: 1, accounts: {}, links: {}, alerts: {}, usage: {}, purchases: [], seenWebhooks: [], seenRequests: {}, enterpriseLeads: [], apiKeys: [], planHistory: {}, adminLog: [] });

const g = globalThis as unknown as { __db?: { file: string; data: DB } };

export const dataFile = () => path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "db.json");

function load(): DB {
  const file = dataFile();
  if (g.__db && g.__db.file === file) return g.__db.data;
  let data = empty();
  try {
    data = { ...empty(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[store] unreadable db.json, starting from scratch:", e);
  }
  g.__db = { file, data };
  return data;
}

function persist() {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 1));
  fs.renameSync(tmp, file);
}

/** Lee y modifica la base de datos; guarda al terminar. */
export function tx<T>(fn: (db: DB) => T): T {
  const db = load();
  const r = fn(db);
  persist();
  return r;
}
export const read = <T>(fn: (db: DB) => T): T => fn(load());

/** Solo para tests: olvida la caché en memoria. */
export const _resetCache = () => { delete g.__db; };

// --- Utilidades de alto nivel ---
export const getAccount = (id: string) => read(db => db.accounts[id] ?? null);
export const saveAccount = (a: Account) => tx(db => { db.accounts[a.customerId] = a; });

export const getLink = (appUserId: string) => read(db => db.links[appUserId] ?? null);
export const findLinkByMetronomeId = (mid: string) => read(db => Object.values(db.links).find(l => l.metronomeCustomerId === mid) ?? null);
export const saveLink = (l: CustomerLink) => tx(db => { db.links[l.appUserId] = l; });

export function addAlert(customerKey: string, alert: Alert) {
  tx(db => {
    const list = (db.alerts[customerKey] ??= []);
    list.unshift(alert);
    db.alerts[customerKey] = list.slice(0, 50);
  });
}
export const getAlerts = (customerKey: string) => read(db => db.alerts[customerKey] ?? []);

export const addPurchase = (p: Purchase) => tx(db => { if (!db.purchases.some(x => x.purchaseId === p.purchaseId)) db.purchases.push(p); });
export const getPurchase = (id: string) => read(db => db.purchases.find(p => p.purchaseId === id) ?? null);
export const pendingPurchases = (customerKey: string) => read(db => db.purchases.filter(p => p.customerKey === customerKey && p.status === "payment_pending"));
export const resolvePurchase = (id: string, status: Purchase["status"]) =>
  tx(db => { const p = db.purchases.find(x => x.purchaseId === id); if (p) { p.status = status; p.resolvedAt = new Date().toISOString(); } });

/** Deduplicación de webhooks por id, persistida en db.json (sobrevive a reinicios). */
export const isWebhookSeen = (id: string) => read(db => db.seenWebhooks.some(w => w.id === id));
/** Devuelve false si el webhook ya se había procesado. Se llama DESPUÉS de procesarlo bien (si falla, el reintento de Metronome vuelve a entrar). */
export function markWebhookSeen(id: string): boolean {
  return tx(db => {
    if (db.seenWebhooks.some(w => w.id === id)) return false;
    db.seenWebhooks.unshift({ id, ts: new Date().toISOString() });
    // Metronome reintenta durante ~2 días: guardamos hasta 5000 ids o 7 días.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
    db.seenWebhooks = db.seenWebhooks.filter(w => w.ts >= cutoff).slice(0, 5000);
    return true;
  });
}

/** Modo en vivo: filtra los ids de petición ya enviados (además, /v1/ingest deduplica por transaction_id 34 días). */
export function claimRequestIds(appUserId: string, ids: string[]): string[] {
  return tx(db => {
    const seen = new Set(db.seenRequests[appUserId] ?? []);
    const fresh = ids.filter(id => !seen.has(id) && (seen.add(id), true));
    db.seenRequests[appUserId] = [...seen].slice(-5000);
    return fresh;
  });
}

export const addEnterpriseLead = (l: DB["enterpriseLeads"][number]) => tx(db => { db.enterpriseLeads.unshift(l); db.enterpriseLeads = db.enterpriseLeads.slice(0, 200); });

// --- Claves de API ---
export const addApiKey = (k: ApiKey) => tx(db => { db.apiKeys.push(k); });
export const listApiKeys = (customerKey: string) => read(db => db.apiKeys.filter(k => k.customerKey === customerKey));
export const findApiKeyByHash = (hash: string) => read(db => db.apiKeys.find(k => k.hash === hash) ?? null);
export const updateApiKey = (id: string, patch: Partial<ApiKey>) => tx(db => { const k = db.apiKeys.find(x => x.id === id); if (k) Object.assign(k, patch); return k ?? null; });

// --- Historial de plan y registro de soporte ---
export const addPlanEvent = (customerKey: string, e: PlanEvent) => tx(db => { (db.planHistory[customerKey] ??= []).unshift(e); db.planHistory[customerKey] = db.planHistory[customerKey].slice(0, 100); });
export const getPlanHistory = (customerKey: string) => read(db => db.planHistory[customerKey] ?? []);
export const addAdminLog = (e: AdminLogEntry) => tx(db => { db.adminLog.unshift(e); db.adminLog = db.adminLog.slice(0, 1000); });
export const getAdminLog = (customerKey?: string) => read(db => (customerKey ? db.adminLog.filter(e => e.customerKey === customerKey) : db.adminLog));

/** Ids de sesión de todos los clientes (simulados o enlazados en vivo), del más reciente al más antiguo. */
export const listCustomerKeys = (mode: "mock" | "metronome") =>
  read(db => (mode === "mock"
    ? Object.values(db.accounts).sort((a, b) => b.periodStart.localeCompare(a.periodStart)).map(a => a.customerId)
    : Object.values(db.links).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(l => l.appUserId)));
