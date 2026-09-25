// Claves de API por usuario: se muestran una sola vez y solo se guarda su hash.
// Hash = HMAC-SHA256(API_KEY_PEPPER, clave) si hay pimienta; si no, SHA-256. Las claves tienen 192 bits aleatorios,
// así que no hace falta un KDF lento (no son contraseñas elegidas por personas).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { addApiKey, findApiKeyByHash, listApiKeys, updateApiKey, type ApiKey } from "./store";

export const MAX_ACTIVE_KEYS = 10;
const PREFIX_LEN = 14;

export function hashKey(key: string) {
  const pepper = process.env.API_KEY_PEPPER;
  return pepper ? createHmac("sha256", pepper).update(key).digest("hex") : createHash("sha256").update(key).digest("hex");
}

export type PublicApiKey = Omit<ApiKey, "hash" | "customerKey">;
export const toPublic = ({ hash: _h, customerKey: _c, ...k }: ApiKey): PublicApiKey => k;

export function createApiKey(customerKey: string, rawName: string, mode: "mock" | "metronome") {
  const name = String(rawName ?? "").trim().slice(0, 40);
  if (!name) throw new Error("Give the key a name (e.g. \"production server\")");
  if (listApiKeys(customerKey).filter(k => !k.revokedAt).length >= MAX_ACTIVE_KEYS) throw new Error(`Maximum ${MAX_ACTIVE_KEYS} active keys: revoke one first`);
  const secret = `nbl_${mode === "mock" ? "test" : "live"}_${randomBytes(24).toString("base64url")}`;
  const rec: ApiKey = { id: `key_${randomUUID().slice(0, 8)}`, customerKey, name, prefix: secret.slice(0, PREFIX_LEN), hash: hashKey(secret), createdAt: new Date().toISOString() };
  addApiKey(rec);
  return { secret, key: toPublic(rec) };
}

export function revokeApiKey(customerKey: string, id: string) {
  const k = listApiKeys(customerKey).find(x => x.id === id);
  if (!k) throw new Error("Key not found");
  if (!k.revokedAt) updateApiKey(id, { revokedAt: new Date().toISOString() });
  return toPublic({ ...k, revokedAt: k.revokedAt ?? new Date().toISOString() });
}

/** Lee la clave de «Authorization: Bearer …» (o «X-API-Key») y devuelve el registro si es válida y no está revocada. */
export function authenticate(headers: Headers): ApiKey | null {
  const auth = headers.get("authorization") ?? "";
  const key = (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : headers.get("x-api-key") ?? "").trim();
  if (!/^nbl_(test|live)_[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
  const h = hashKey(key);
  const rec = findApiKeyByHash(h);
  if (!rec || rec.revokedAt) return null;
  if (!timingSafeEqual(Buffer.from(rec.hash, "hex"), Buffer.from(h, "hex"))) return null;
  if (!rec.lastUsedAt || Date.now() - +new Date(rec.lastUsedAt) > 30_000) updateApiKey(rec.id, { lastUsedAt: new Date().toISOString() });
  return rec;
}
