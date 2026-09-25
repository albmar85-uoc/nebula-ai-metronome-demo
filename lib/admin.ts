// Panel de soporte de la demo: contraseña única por variable de entorno (ADMIN_PASSWORD; por defecto "nebula-admin").
// Solo para la demo local: en producción iría detrás del SSO de la empresa con roles y auditoría centralizada.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { addAdminLog } from "./store";
import { nowIso } from "./clock";

export const ADMIN_COOKIE = "demo_admin";
export const DEFAULT_ADMIN_PASSWORD = "nebula-admin";
export const adminPassword = () => process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
/** Token de sesión derivado de la contraseña: cambiarla invalida las sesiones abiertas. */
export const adminToken = () => createHmac("sha256", adminPassword()).update("nebula-admin-session-v1").digest("hex");
export const ADMIN_COOKIE_OPTS = { httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: 8 * 3600 };

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const checkPassword = (p: unknown) => typeof p === "string" && eq(createHmac("sha256", "cmp").update(p).digest("hex"), createHmac("sha256", "cmp").update(adminPassword()).digest("hex"));
export const isAdmin = () => { const c = cookies().get(ADMIN_COOKIE)?.value; return !!c && eq(c, adminToken()); };

// Freno simple a la fuerza bruta (en memoria, por IP): 10 intentos por minuto.
const attempts = new Map<string, number[]>();
export function tooManyAttempts(ip: string) {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter(t => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 10;
}

export async function withAdmin(fn: () => Promise<unknown>) {
  if (!isAdmin()) return NextResponse.json({ error: "Support access required" }, { status: 401 });
  try { return NextResponse.json(await fn(), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}

export const logAdmin = (customerKey: string, action: string, detail: string) =>
  addAdminLog({ id: `adm_${randomUUID().slice(0, 8)}`, ts: nowIso(), customerKey, action, detail });
