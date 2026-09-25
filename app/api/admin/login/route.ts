import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_COOKIE_OPTS, adminToken, checkPassword, isAdmin, tooManyAttempts } from "@/lib/admin";

export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json({ admin: isAdmin() }); }
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (tooManyAttempts(ip)) return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
  const { password } = await req.json().catch(() => ({}));
  if (!checkPassword(password)) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const res = NextResponse.json({ admin: true });
  res.cookies.set(ADMIN_COOKIE, adminToken(), ADMIN_COOKIE_OPTS);
  return res;
}
export async function DELETE() {
  const res = NextResponse.json({ admin: false });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}
