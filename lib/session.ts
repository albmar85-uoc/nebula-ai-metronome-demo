import { cookies } from "next/headers";
export const COOKIE = "demo_customer";
/** Cookie de sesión de la demo (30 días, para que la sesión sobreviva a reinicios del navegador). */
export const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 30 };
export const currentCustomerId = () => cookies().get(COOKIE)?.value ?? null;
